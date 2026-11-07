'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Settings } = require('../src/core/settings');
const { ModManager } = require('../src/core/manager');
const placement = require('../src/core/placement');

const SEVEN_ZIP = require('./seven-zip');
const has7z = fs.existsSync(SEVEN_ZIP);
const quiet = { info() {}, warn() {}, error() {}, success() {}, debug() {} };

function gameFolder() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-place-'));
  const game = path.join(root, 'Cyberpunk 2077');
  fs.mkdirSync(path.join(game, 'bin', 'x64'), { recursive: true });
  fs.writeFileSync(path.join(game, 'bin', 'x64', 'Cyberpunk2077.exe'), 'exe');
  fs.mkdirSync(path.join(game, 'archive', 'pc', 'content'), { recursive: true });
  fs.writeFileSync(path.join(game, 'archive', 'pc', 'content', 'basegame_1.archive'), 'game');
  return { root, game };
}

test('cleanDest: only plain paths inside the game folder', () => {
  assert.strictEqual(placement.cleanDest('archive\\pc\\mod\\A.archive'), 'archive/pc/mod/A.archive');
  for (const bad of ['', '../x', 'a/../../x', 'C:/Windows/x.dll', '/etc/passwd', 'a//b', 'a/./b', 'a/con.txt', 'a/b.', 'a/b ', 'a/b?c', 'a/<b>', 'a/b\u0001', 'x'.repeat(401), 12, null]) {
    assert.strictEqual(placement.cleanDest(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test('checkPlacement: unknown files, two to one place, a file where a folder goes, game files and things in the way', () => {
  const { game } = gameFolder();
  fs.writeFileSync(path.join(game, 'archive', 'pc', 'blocker'), 'a file named like a folder');
  const deployed = { 'archive/pc/mod/other.archive': { owner: 'other-mod' } };
  fs.mkdirSync(path.join(game, 'archive', 'pc', 'mod'), { recursive: true });
  fs.writeFileSync(path.join(game, 'archive', 'pc', 'mod', 'other.archive'), 'theirs');
  const files = ['a.archive', 'b.archive', 'c.txt', 'd.archive', 'e.archive', 'f.archive', 'g.archive'];
  const r = placement.checkPlacement({
    gameDir: game, deployed, files,
    pairs: [
      { src: 'a.archive', dest: 'archive/pc/mod/a.archive' },
      { src: 'b.archive', dest: 'archive/pc/mod/A.archive' },         // same place as a, other case
      { src: 'nope.archive', dest: 'archive/pc/mod/nope.archive' },  // not in the download
      { src: 'c.txt', dest: 'archive/pc/content/basegame_1.archive' }, // a game file
      { src: 'd.archive', dest: 'archive/pc/mod/other.archive' },     // another mod's file: allowed
      { src: 'e.archive', dest: 'archive/pc/blocker/e.archive' },     // a file in the way
      { src: 'f.archive', dest: 'x/f' },
      { src: 'g.archive', dest: 'x/f/g.archive' },                    // f is a file, not a folder
    ],
  });
  const kinds = Object.fromEntries(r.problems.map(p => [p.src, p.kind]));
  assert.deepStrictEqual(kinds, { 'b.archive': 'dup', 'nope.archive': 'bad', 'c.txt': 'game', 'e.archive': 'blocked', 'g.archive': 'nest' });
  assert.deepStrictEqual(r.mods, { 'archive/pc/mod/other.archive': 'other-mod' });
  assert.strictEqual(placement.checkPlacement({ gameDir: game, deployed, files, pairs: 'x' }).problems[0].kind, 'bad');
});

test('listGameDir: one folder at a time, owners of mod files, never outside the game folder', () => {
  const { game } = gameFolder();
  fs.mkdirSync(path.join(game, 'archive', 'pc', 'mod'), { recursive: true });
  fs.writeFileSync(path.join(game, 'archive', 'pc', 'mod', 'x.archive'), 'x');
  const r = placement.listGameDir(game, 'archive/pc', { 'archive/pc/mod/x.archive': { owner: 'm1' } });
  assert.deepStrictEqual(r.dirs, ['content', 'mod']);
  assert.deepStrictEqual(placement.listGameDir(game, 'archive/pc/mod', { 'archive/pc/mod/x.archive': { owner: 'm1' } }).files, [{ name: 'x.archive', owner: 'm1' }]);
  assert.deepStrictEqual(placement.listGameDir(game, 'not/there', {}), { dirs: [], files: [], more: 0 });
  assert.throws(() => placement.listGameDir(game, '../..', {}));
  assert.throws(() => placement.listGameDir(game, 'C:/Windows', {}));
});

function managerSetup() {
  const { root, game } = gameFolder();
  const settings = new Settings(path.join(root, 'userdata'), null);
  settings.update({ gamePath: game, sevenZipPath: SEVEN_ZIP });
  const mgr = new ModManager({ settings, log: quiet });
  const zip = (name, files) => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-src-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
      fs.writeFileSync(path.join(src, rel), content);
    }
    const out = path.join(root, name);
    execFileSync(SEVEN_ZIP, ['a', '-bso0', '-bsp0', out, '*'], { cwd: src });
    return out;
  };
  return { game, mgr, zip };
}

test('an archive the layout rules can\'t read opens the Place files window; Apply installs what was placed', { skip: !has7z && '7-Zip not installed' }, async () => {
  const { game, mgr, zip } = managerSetup();
  const asked = [];
  mgr.on('place', req => asked.push(req));
  const [key] = await mgr.importArchives([zip('Neon.zip', { 'Neon/neon.bk2': 'video', 'Neon/settings.json': '{}', 'readme.txt': 'hi' })]);
  const [res] = await mgr.install([key]);
  assert.ok(res.place, 'the install waits for the window');
  assert.strictEqual(asked.length, 1);
  const req = asked[0];
  assert.deepStrictEqual(req.files.map(f => f.path).sort(), ['Neon/neon.bk2', 'Neon/settings.json', 'readme.txt']);
  assert.ok(req.roots.includes('archive/pc/mod'));
  assert.ok(mgr.busy, 'an update waits while the window is open');

  // The window's helpers: a folder of the game, and a check.
  assert.deepStrictEqual(mgr.placeList(req.token, 'archive/pc').dirs, ['content']);
  const bad = mgr.placeCheck(req.token, [{ src: 'Neon/neon.bk2', dest: 'archive/pc/content/basegame_1.archive' }]);
  assert.strictEqual(bad.problems[0].kind, 'game');
  await assert.rejects(mgr.placeSubmit(req.token, [{ src: 'Neon/neon.bk2', dest: 'archive/pc/content/basegame_1.archive' }]), /game file/);
  assert.ok(mgr.pendingPlace.has(req.token), 'a refused Apply leaves the window open');

  const out = await mgr.placeSubmit(req.token, [
    { src: 'Neon/neon.bk2', dest: 'r6/movies/neon.bk2' },
    { src: 'Neon/settings.json', dest: 'bin/x64/plugins/cyber_engine_tweaks/mods/Neon/settings.json' },
  ]);
  assert.ok(out.id);
  assert.ok(!mgr.pendingPlace.size && !mgr.busy);
  const mod = mgr.data.mods[out.id];
  assert.deepStrictEqual(mod.files.sort(), ['bin/x64/plugins/cyber_engine_tweaks/mods/Neon/settings.json', 'r6/movies/neon.bk2']);
  assert.deepStrictEqual(mod.placed.map(p => p[0]).sort(), ['Neon/neon.bk2', 'Neon/settings.json']);
  assert.strictEqual(mod.enabled, false, 'nothing reaches the game until it is enabled');
  assert.ok(!fs.existsSync(path.join(game, 'r6', 'movies', 'neon.bk2')));
  await mgr.setEnabled([out.id], true);
  assert.strictEqual(fs.readFileSync(path.join(game, 'r6', 'movies', 'neon.bk2'), 'utf8'), 'video');
  assert.strictEqual(fs.readFileSync(path.join(game, 'archive', 'pc', 'content', 'basegame_1.archive'), 'utf8'), 'game', 'game files untouched');

  // Installed again: the window opens with the same places filled in.
  await mgr.install([key]);
  const again = asked[1];
  assert.deepStrictEqual(again.preset, { 'Neon/neon.bk2': 'r6/movies/neon.bk2', 'Neon/settings.json': 'bin/x64/plugins/cyber_engine_tweaks/mods/Neon/settings.json' });
  mgr.placeCancel(again.token);
  assert.ok(!mgr.pendingPlace.size);
  assert.throws(() => mgr.placeList(again.token, ''), /expired/);
  await assert.rejects(mgr.placeSubmit(again.token, []), /expired/);
});

test('an archive the rules can read never opens the window', { skip: !has7z && '7-Zip not installed' }, async () => {
  const { mgr, zip } = managerSetup();
  let asked = 0;
  mgr.on('place', () => { asked++; });
  const [key] = await mgr.importArchives([zip('Known.zip', { 'Known.archive': 'a' })]);
  const [res] = await mgr.install([key]);
  assert.ok(res.id && !res.place);
  assert.strictEqual(asked, 0);
});

test('(audit) a link in the game folder to a folder outside it is never listed or placed into', () => {
  const { root, game } = gameFolder();
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'private.txt'), 'not the game');
  fs.mkdirSync(path.join(game, 'mods'), { recursive: true });
  try { fs.symlinkSync(outside, path.join(game, 'mods', 'link'), 'junction'); } catch { return; } // no links here
  assert.deepStrictEqual(placement.listGameDir(game, 'mods/link', {}).files, []);
  const r = placement.checkPlacement({ gameDir: game, deployed: {}, files: ['x.lua'], pairs: [{ src: 'x.lua', dest: 'mods/link/x.lua' }] });
  assert.strictEqual(r.problems[0]?.kind, 'outside');
  // A link that stays inside the game folder is fine.
  fs.mkdirSync(path.join(game, 'r6', 'real'), { recursive: true });
  fs.symlinkSync(path.join(game, 'r6', 'real'), path.join(game, 'mods', 'inner'), 'junction');
  assert.deepStrictEqual(placement.checkPlacement({ gameDir: game, deployed: {}, files: ['x.lua'], pairs: [{ src: 'x.lua', dest: 'mods/inner/x.lua' }] }).problems, []);
});

test('(audit) more names Windows keeps for itself, and invisible characters, are refused', () => {
  for (const bad of ['a/CLOCK$', 'conin$', 'a/COM¹.txt', 'a/LPT²', 'a/‮readme', 'a/b ']) assert.strictEqual(placement.cleanDest(bad), null, bad);
  assert.strictEqual(placement.cleanDest('r6/scripts/Clock Mod/clock.reds'), 'r6/scripts/Clock Mod/clock.reds');
});

test('(audit) an empty archive never opens the window', { skip: !has7z && '7-Zip not installed' }, async () => {
  const { mgr } = managerSetup();
  let asked = 0;
  mgr.on('place', () => { asked++; });
  const session = { token: 't', extractDir: '', files: [], fomod: null };
  mgr.installer.prepare = async () => session;
  mgr.installer.release = () => {};
  const rec = { key: 'k', name: 'Empty', fileName: 'Empty.zip', path: __filename, modName: 'Empty' };
  await assert.rejects(mgr.installOne(rec, {}), /looks like a Cyberpunk 2077 mod/);
  assert.strictEqual(asked, 0);
});
