'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { linuxNxm, execLine, MARK } = require('../src/core/nxmLinux');

/*
 * Linux, "Handle Mod Manager download links": Electron only accepts an app whose .desktop file is
 * installed, and an AppImage installs none, so the switch failed with "Windows did not accept this
 * app". The AppImage now writes a hidden entry of its own, and turning the switch off gives the links back.
 */
const ID = 'edgerunners-mod-manager.desktop';
const DEFAULTS = '[Default Applications]';
const ADDED = '[Added Associations]';
const KEY = 'x-scheme-handler/nxm';

function setup(appImage = '/home/v/Apps/Edgerunners.AppImage') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nxm-linux-'));
  const env = { XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), CHROME_DESKTOP: ID };
  fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  const entry = path.join(env.XDG_DATA_HOME, 'applications', ID);
  const list = path.join(env.XDG_CONFIG_HOME, 'mimeapps.list');
  return { root, env, entry, list, saved: path.join(root, 'saved.txt'), nxm: linuxNxm({ appImage, handlerName: () => 'Some App', env }) };
}

test('the program path is quoted the way the Desktop Entry spec asks', () => {
  assert.strictEqual(execLine('/home/v/Edgerunners.AppImage'), '"/home/v/Edgerunners.AppImage" %U');
  assert.strictEqual(execLine('/home/v/My Apps/E.AppImage'), '"/home/v/My Apps/E.AppImage" %U');
  assert.strictEqual(execLine('/a/$HOME/E'), '"/a/\\\\$HOME/E" %U', 'a dollar is never expanded');
  assert.strictEqual(execLine('/a/`x`/E'), '"/a/\\\\`x\\\\`/E" %U', 'a backtick is never run');
  assert.strictEqual(execLine('/a/"q"/E'), '"/a/\\\\"q\\\\"/E" %U');
  assert.strictEqual(execLine('/a/b\\c/E'), '"/a/b\\\\\\\\c/E" %U');
  assert.strictEqual(execLine('/a/100%/E'), '"/a/100%%/E" %U', 'a percent sign is not a field code');
});

test('a path with a line break cannot add lines to the entry', () => {
  const s = setup('/a/b\nExec=/bin/evil');
  assert.throws(() => s.nxm.prepare(), /line break/);
  assert.strictEqual(fs.existsSync(s.entry), false);
});

test('an AppImage writes its hidden entry under the name Electron looks for', () => {
  const s = setup();
  s.nxm.prepare();
  const text = fs.readFileSync(s.entry, 'utf8');
  assert.match(text, /^\[Desktop Entry\]\n/);
  assert.match(text, /^Type=Application$/m);
  assert.match(text, /^Exec="\/home\/v\/Apps\/Edgerunners\.AppImage" %U$/m);
  assert.match(text, /^MimeType=x-scheme-handler\/nxm;$/m);
  assert.match(text, /^NoDisplay=true$/m, 'no second icon in the applications menu');
  assert.ok(text.includes(MARK));
});

test('the entry follows the AppImage when it is moved or renamed by an update', () => {
  const s = setup('/old/E-1.AppImage');
  s.nxm.prepare();
  linuxNxm({ appImage: '/new/E-2.AppImage', env: s.env }).prepare();
  assert.match(fs.readFileSync(s.entry, 'utf8'), /^Exec="\/new\/E-2\.AppImage" %U$/m);
});

test('a .deb keeps the entry it installed: nothing is written', () => {
  const s = setup('');
  s.nxm.prepare();
  assert.strictEqual(fs.existsSync(s.entry), false);
});

test('an entry of that name the user made is neither replaced nor removed', () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.entry), { recursive: true });
  const mine = '[Desktop Entry]\nType=Application\nName=Mine\nExec=/mine %U\n';
  fs.writeFileSync(s.entry, mine);
  s.nxm.prepare();
  assert.strictEqual(fs.readFileSync(s.entry, 'utf8'), mine);
  s.nxm.release();
  assert.strictEqual(fs.readFileSync(s.entry, 'utf8'), mine);
});

test('with the XDG folders unset or relative, the standard ones in the home folder are used', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nxm-home-'));
  t.mock.method(os, 'homedir', () => home);
  linuxNxm({ appImage: '/a/E', env: { CHROME_DESKTOP: ID, XDG_DATA_HOME: 'relative/path' } }).prepare();
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'applications', ID)));
  assert.strictEqual(fs.existsSync(path.join('relative', 'path')), false);
});

test('the handler in use before is saved', async () => {
  const s = setup();
  fs.writeFileSync(s.list, `${DEFAULTS}\ntext/plain=gedit.desktop\n${KEY}=limo.desktop\n`);
  assert.strictEqual(await s.nxm.backup(s.saved), true);
  assert.strictEqual(fs.readFileSync(s.saved, 'utf8').trim(), 'limo.desktop');
});

test('nothing is saved when no handler was set, or only this app', async () => {
  const s = setup();
  assert.strictEqual(await s.nxm.backup(s.saved), false, 'no mimeapps.list');
  fs.writeFileSync(s.list, `${DEFAULTS}\ntext/plain=gedit.desktop\n`);
  assert.strictEqual(await s.nxm.backup(s.saved), false, 'no line for these links');
  fs.writeFileSync(s.list, `${DEFAULTS}\n${KEY}=${ID}\n`);
  assert.strictEqual(await s.nxm.backup(s.saved), false, 'this app is not "the one before"');
  assert.strictEqual(fs.existsSync(s.saved), false);
});

test('a key of the same name in another section is not read as the handler', async () => {
  const s = setup();
  fs.writeFileSync(s.list, `${ADDED}\n${KEY}=limo.desktop;\n`);
  assert.strictEqual(await s.nxm.backup(s.saved), false);
});

test('turning it off puts the earlier handler back and leaves every other line alone', async () => {
  const s = setup();
  s.nxm.prepare();
  fs.writeFileSync(s.saved, 'limo.desktop\n');
  fs.writeFileSync(s.list, `${DEFAULTS}\ntext/plain=gedit.desktop\n${KEY}=${ID}\n\n${ADDED}\ntext/plain=gedit.desktop;\n${KEY}=${ID};limo.desktop;\n`);
  assert.strictEqual(await s.nxm.restore(s.saved), true);
  assert.strictEqual(fs.readFileSync(s.list, 'utf8'), `${DEFAULTS}\ntext/plain=gedit.desktop\n${KEY}=limo.desktop\n\n${ADDED}\ntext/plain=gedit.desktop;\n${KEY}=limo.desktop;\n`);
  assert.strictEqual(fs.existsSync(s.entry), false, 'the hidden entry goes too');
});

test('with nothing saved, the app simply stops being the handler', async () => {
  const s = setup();
  s.nxm.prepare();
  fs.writeFileSync(s.list, `${DEFAULTS}\n${KEY}=${ID}\n\n${ADDED}\n${KEY}=${ID};\n`);
  assert.strictEqual(await s.nxm.restore(''), false);
  assert.strictEqual(fs.readFileSync(s.list, 'utf8'), `${DEFAULTS}\n\n${ADDED}\n`);
  assert.strictEqual(fs.existsSync(s.entry), false);
});

test('a symlinked list (a dotfiles manager\'s) stays a link: the file it points to is what changes', async t => {
  const s = setup();
  const real = path.join(s.root, 'dotfiles-mimeapps.list');
  fs.writeFileSync(real, `${DEFAULTS}\ntext/plain=gedit.desktop\n${KEY}=${ID}\n`);
  try { fs.symlinkSync(real, s.list); } catch (err) { if (err.code === 'EPERM') return t.skip('this Windows account cannot make symlinks'); throw err; }
  await s.nxm.restore('');
  assert.ok(fs.lstatSync(s.list).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(real, 'utf8'), `${DEFAULTS}\ntext/plain=gedit.desktop\n`);
});

test('a failed write leaves no temporary file and the list as it was', async () => {
  const s = setup();
  const before = `${DEFAULTS}\n${KEY}=${ID}\n`;
  fs.writeFileSync(s.list, before);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk full'); };
  try { await assert.rejects(s.nxm.restore(''), /disk full/); } finally { fs.renameSync = rename; }
  assert.strictEqual(fs.readFileSync(s.list, 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(s.env.XDG_CONFIG_HOME), ['mimeapps.list']);
});

test('the name shown for the handler comes from the desktop', async () => {
  const s = setup();
  assert.strictEqual(s.nxm.describe(await s.nxm.readCommand()), 'Some App');
});

const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

test('main.js uses the Linux handler, prepares its entry first, and only says Windows on Windows', () => {
  const main = src('main.js');
  assert.match(main, /process\.platform === 'win32' \? require\('\.\/core\/nxmHandler'\) : require\('\.\/core\/nxmLinux'\)/);
  const body = main.slice(main.indexOf('async function applyNxmSetting'), main.indexOf('REDmod deploy, when the REDmods'));
  assert.ok(body.indexOf('nxm.prepare') > 0 && body.indexOf('nxm.prepare') < body.indexOf('isDefaultProtocolClient'), 'the entry exists before asking who handles the links');
  assert.doesNotMatch(body, /new Error\('Windows did not accept/);
});

test('Settings only names Windows on Windows', () => {
  const app = src(path.join('renderer', 'app.js'));
  assert.doesNotMatch(app, /title: 'Windows did not switch'/);
});
