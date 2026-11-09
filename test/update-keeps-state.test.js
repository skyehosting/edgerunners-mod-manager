'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const { setupGroups } = require('../src/core/groups/app');

/*
 * A new version never changes whether a mod is on. The Update button always kept that; a newer file
 * arriving any other way (the Nexus page's Mod Manager Download, a reinstall, Group Mods' Get) was
 * treated as a new mod and switched on.
 */
const SEVEN_ZIP = require('./seven-zip');
const skip = { skip: !fs.existsSync(SEVEN_ZIP) && '7-Zip not installed' };
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-upd-'));
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  const settings = new Settings(path.join(root, 'userdata'), null);
  settings.update({ gamePath: game, sevenZipPath: SEVEN_ZIP });
  const mgr = new ModManager({ settings, log: quiet });
  const zip = (name, files) => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-src-'));
    for (const [rel, content] of Object.entries(files)) fs.writeFileSync(path.join(src, rel), content);
    const out = path.join(root, name);
    execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
    return out;
  };
  return { root, game, settings, mgr, zip };
}

const NEXUS = { game: 'cyberpunk2077', modId: 50, modName: 'Thing' };

/** "Thing" 1.0 installed, on or off. */
async function installed(s, enabled, extra = {}) {
  const [key] = await s.mgr.importArchives([s.zip('Thing-1.zip', { 'thing.archive': 'v1' })]);
  Object.assign(s.mgr.data.downloads[key], NEXUS, { fileId: 500, version: '1.0', category: 'MAIN', ...extra });
  const [res] = await s.mgr.install([key]);
  Object.assign(s.mgr.data.mods[res.id], NEXUS, { fileId: 500, version: '1.0', category: 'MAIN', ...extra });
  if (enabled) await s.mgr.setEnabled([res.id], true);
  return res.id;
}

/** A finished download of file `key`, handed over as the downloader does. */
async function downloaded(s, key, job = {}) {
  const dest = path.join(s.root, `dl-${key}.zip`);
  fs.copyFileSync(s.zip(`src-${key}.zip`, { [`${job.fileName || 'thing'}.archive`]: 'v2' }), dest);
  s.mgr.onDownloaded({ ...NEXUS, key, fileId: Number(key) || 0, name: 'Thing', fileName: `Thing-${key}.zip`, version: '2.0', category: 'MAIN', total: 10, uploaded: 0, author: '', picture: '', dest, dependencyOf: '', ...job });
  await new Promise(r => setTimeout(r, 60));
  await s.mgr.chain;
  await s.mgr.chain;
}

const byVersion = s => Object.fromEntries(Object.values(s.mgr.data.mods).map(m => [m.version, m.enabled]));

test('the Update button: a mod that is off stays off', skip, async () => {
  const s = setup();
  const id = await installed(s, false);
  await downloaded(s, '501', { replaces: id });
  assert.deepStrictEqual(byVersion(s), { '2.0': false });
  assert.deepStrictEqual(s.mgr.data.profiles?.list?.default?.enabled || [], []);
  assert.ok(!fs.existsSync(path.join(s.game, 'archive/pc/mod/thing.archive')), 'nothing reaches the game');
});

test('a newer file from the Nexus page: off stays off, and is noted in the log', skip, async () => {
  const s = setup();
  const notes = [];
  s.mgr.log = { ...quiet, info: m => notes.push(m) };
  await installed(s, false);
  await downloaded(s, '501');
  assert.deepStrictEqual(byVersion(s), { '1.0': false, '2.0': false });
  assert.ok(!fs.existsSync(path.join(s.game, 'archive/pc/mod/thing.archive')), 'nothing reaches the game');
  assert.ok(notes.some(n => /stays off/.test(n)), 'the log says why it did not switch on');
});

test('a newer file from the Nexus page: a mod in use still gets its new version switched on', skip, async () => {
  const s = setup();
  await installed(s, true);
  await downloaded(s, '501');
  assert.strictEqual(byVersion(s)['2.0'], true);
});

test('Main, Update and Old version are one line: an off file that has since become an old version counts', skip, async () => {
  const s = setup();
  await installed(s, false, { category: 'OLD_VERSION' });
  await downloaded(s, '501', { category: 'UPDATE' });
  assert.strictEqual(byVersion(s)['2.0'], false);
});

test('a file installed by hand (only its Nexus id known) counts as that mod\'s version: off stays off', skip, async () => {
  const s = setup();
  await installed(s, false, { category: 'LOCAL' });
  await downloaded(s, '501');
  assert.deepStrictEqual(byVersion(s), { '1.0': false, '2.0': false });
});

test('an optional file of a mod whose main file is off is its own thing: switched on as usual', skip, async () => {
  const s = setup();
  await installed(s, false);
  await downloaded(s, '501', { category: 'OPTIONAL', fileName: 'patch' });
  assert.strictEqual(byVersion(s)['2.0'], true);
});

test('a mod that is new here is switched on as usual; the setting still turns that off', skip, async () => {
  const s = setup();
  await installed(s, false);
  await downloaded(s, '900', { modId: 77, modName: 'Other', fileName: 'other' });
  assert.strictEqual(byVersion(s)['2.0'], true);
  s.settings.update({ autoEnable: false });
  await downloaded(s, '901', { modId: 78, modName: 'Third', fileName: 'third', version: '3.0' });
  assert.strictEqual(byVersion(s)['3.0'], false);
});

test('mod.io: a newer file of a mod that is off stays off', skip, async () => {
  const s = setup();
  const modio = { id: 9, fileId: 11 };
  const id = await installed(s, false, { source: 'modio', modio, modId: 0, fileId: 0 });
  assert.ok(s.mgr.data.mods[id]);
  Object.assign(s.mgr.data.mods[id], { modio, source: 'modio', modId: 0, fileId: 0 });
  await downloaded(s, 'modio-12', { source: 'modio', modio: { id: 9, fileId: 12 }, modId: 0, fileId: 0 });
  assert.strictEqual(byVersion(s)['2.0'], false);
});

test('a reinstall of a mod that is off stays off', skip, async () => {
  const s = setup();
  const id = await installed(s, false);
  const [res] = await s.mgr.install([id], { auto: true });
  assert.strictEqual(res.id, id);
  assert.strictEqual(s.mgr.data.mods[id].enabled, false);
});

test('a reinstall of a mod that is on stays on, however it starts', skip, async () => {
  for (const opts of [{}, { auto: true }]) {
    const s = setup();
    const id = await installed(s, true);
    await s.mgr.install([id], opts);
    assert.strictEqual(s.mgr.data.mods[id].enabled, true, JSON.stringify(opts));
    assert.ok(fs.existsSync(path.join(s.game, 'archive/pc/mod/thing.archive')), 'still in the game');
  }
});

test('updating an off version to a file that is already installed and on leaves that file on', skip, async () => {
  const s = setup();
  const id = await installed(s, false);
  await downloaded(s, '501', { modId: 51, fileName: 'other' }); // the newer file, on, not yet seen as this mod's
  assert.strictEqual(s.mgr.data.mods['501'].enabled, true);
  await downloaded(s, '501', { replaces: id, fileName: 'other' });
  assert.deepStrictEqual(byVersion(s), { '2.0': true });
});

test('an update whose old version was removed meanwhile does not switch anything on', skip, async () => {
  const s = setup();
  const id = await installed(s, false);
  await s.mgr.uninstall([id]);
  await downloaded(s, '501', { replaces: id });
  assert.deepStrictEqual(byVersion(s), { '2.0': false });
});

test('a requirement another mod needs is still switched on, even over an off older version', skip, async () => {
  const s = setup();
  s.settings.update({ installDependencies: true });
  await installed(s, false);
  await downloaded(s, '501', { dependencyOf: 'Parent' });
  assert.strictEqual(byVersion(s)['2.0'], true);
});

test('an imported profile waiting for that update still gets it on', skip, async () => {
  const s = setup();
  const id = await installed(s, false);
  await downloaded(s, '501', { replaces: id, forProfiles: [s.mgr.data.profiles.active] });
  assert.deepStrictEqual(byVersion(s), { '2.0': true });
});

function groupsFor(s) {
  const calls = {};
  const app = setupGroups({ manager: s.mgr, settings: s.settings, userData: path.join(s.root, 'userdata'), cipher: null, log: quiet, send() {}, handle: (name, fn) => { calls[name] = fn; }, gameRunning: () => false });
  app.service.need = () => {};
  app.service.markRequested = () => {};
  return (picks) => calls['groups:download']('a'.repeat(32), picks, []);
}

test('Group Mods Get, with the new version already downloaded: off stays off, on stays on', skip, async () => {
  for (const was of [false, true]) {
    const s = setup();
    await installed(s, was);
    const get = groupsFor(s);
    const dest = path.join(s.root, 'dl-501.zip');
    fs.copyFileSync(s.zip('src-501.zip', { 'thing.archive': 'v2' }), dest);
    s.mgr.data.downloads['501'] = { ...NEXUS, key: '501', fileId: 501, name: 'Thing', fileName: 'Thing-2.zip', version: '2.0', category: 'MAIN', path: dest };
    const r = await get([{ modId: 50, fileId: 501 }]);
    assert.strictEqual(r.installed, 1);
    assert.deepStrictEqual(byVersion(s), { '2.0': was }, `it was ${was ? 'on' : 'off'}`);
    const inProfile = s.mgr.data.profiles.list[s.mgr.data.profiles.active].enabled.includes('501');
    assert.strictEqual(inProfile, was, 'the profile agrees');
  }
});

test('Group Mods Get over a hand-installed copy of that mod: it is that mod\'s older version, so off stays off', skip, async () => {
  const s = setup();
  await installed(s, false, { category: 'LOCAL' });
  const get = groupsFor(s);
  const dest = path.join(s.root, 'dl-501.zip');
  fs.copyFileSync(s.zip('src-501.zip', { 'thing.archive': 'v2' }), dest);
  s.mgr.data.downloads['501'] = { ...NEXUS, key: '501', fileId: 501, name: 'Thing', fileName: 'Thing-2.zip', version: '2.0', category: 'MAIN', path: dest };
  await get([{ modId: 50, fileId: 501 }]);
  assert.deepStrictEqual(byVersion(s), { '2.0': false });
});

test('Group Mods Get, downloading the new version: an off mod stays off; a mod not here is switched on', skip, async () => {
  const s = setup();
  const id = await installed(s, false);
  const get = groupsFor(s);
  const queued = [];
  s.mgr.downloader.enqueue = spec => { queued.push(spec); return spec; };
  s.mgr.fetchModInfo = async (game, modId) => ({ ...NEXUS, modId, name: `Mod ${modId}`, files: [{ file_id: modId === 50 ? 501 : 700, category_name: 'MAIN', file_name: 'x.zip', name: 'x' }] });
  await get([{ modId: 50, fileId: 501 }, { modId: 70, fileId: 700 }]);
  assert.strictEqual(queued[0].replaces, id);
  assert.deepStrictEqual(queued[0].forProfiles || [], [], 'the update takes the old version\'s state and profiles');
  assert.deepStrictEqual(queued[1].forProfiles, [s.mgr.data.profiles.active], 'a mod new here still joins the profile in use');
});
