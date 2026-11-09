'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Linux: who opens nxm:// links ("Mod Manager Download" on Nexus). The same calls as nxmHandler.js,
 * which does this through the Windows registry.
 *
 * Electron makes an app the handler only if a .desktop file of the app's desktop name
 * (CHROME_DESKTOP) is installed. A .deb has one; an AppImage installs nothing, so it writes a hidden
 * one of its own while it has the links. Electron then records the choice in the user's mimeapps.list.
 * Electron cannot undo that on Linux, so turning it off edits the list here.
 */
const MIME = 'x-scheme-handler/nxm';
const DEFAULTS = 'Default Applications';
const ADDED = 'Added Associations';
const MARK = 'X-Edgerunners-Nxm-Handler=true'; // an entry without it is the user's: never changed

/** The Exec line for a program path, quoted as the Desktop Entry spec asks. */
function execLine(program) {
  if (/[\r\n]/.test(program)) throw new Error('The AppImage\'s path has a line break in it, so it cannot be set as the handler for Nexus links.');
  const quoted = program.replace(/["`$\\]/g, '\\$&').replace(/%/g, '%%');
  return `"${quoted.replace(/\\/g, '\\\\')}" %U`; // a .desktop value unescapes its backslashes once more
}

const entryText = program => [
  '[Desktop Entry]', 'Type=Application', 'Name=Edgerunners Mod Manager', `Exec=${execLine(program)}`,
  `MimeType=${MIME};`, 'NoDisplay=true', 'Terminal=false', MARK, '',
].join('\n');

/** Where a key is in a section of an .ini-style text: its section's line, the section's end, the key's line (-1 if none). */
function locate(lines, section, key) {
  const start = lines.findIndex(l => l.trim() === `[${section}]`);
  if (start < 0) return { start, end: start, at: -1 };
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++;
  const at = lines.findIndex((l, i) => i > start && i < end && l.split('=')[0].trim() === key);
  return { start, end, at };
}

function valueIn(text, section, key) {
  const lines = text.split('\n');
  const { at } = locate(lines, section, key);
  return at < 0 ? '' : lines[at].slice(lines[at].indexOf('=') + 1).trim();
}

/** The text with a key's value replaced; an empty value removes the key. A key not there stays not there. */
function withValue(text, section, key, value) {
  const lines = text.split('\n');
  const { at } = locate(lines, section, key);
  if (at < 0) return text;
  lines.splice(at, 1, ...(value ? [`${key}=${value}`] : []));
  return lines.join('\n');
}

function readIfThere(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return ''; throw err; }
}

function writeWhole(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let target = file;
  try { target = fs.realpathSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; } // a link stays a link
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** XDG says a relative value is to be ignored. */
const xdgHome = (value, standard) => (value && path.isAbsolute(value) ? value : path.join(os.homedir(), standard));

/**
 * appImage: the AppImage's path ('' for any other install). handlerName: the desktop's name for
 * whichever program opens these links now. env: where the XDG folders and the desktop name are read.
 */
function linuxNxm({ appImage = '', handlerName = () => '', env = process.env }) {
  const entryFile = () => path.join(xdgHome(env.XDG_DATA_HOME, path.join('.local', 'share')), 'applications', env.CHROME_DESKTOP);
  const listFile = () => path.join(xdgHome(env.XDG_CONFIG_HOME, '.config'), 'mimeapps.list');
  const others = list => list.split(';').filter(id => id && id !== env.CHROME_DESKTOP);

  /** The entry the desktop needs, at the AppImage's current path (it may have moved, or been renamed by an update). */
  function prepare() {
    if (!appImage) return;
    const now = readIfThere(entryFile());
    if (now && !now.includes(MARK)) return;
    const text = entryText(appImage);
    if (now !== text) writeWhole(entryFile(), text);
  }

  /** The hidden entry removed, so a program that no longer wants the links is not offered them. */
  function release() {
    if (readIfThere(entryFile()).includes(MARK)) fs.rmSync(entryFile(), { force: true });
  }

  return {
    prepare,
    release,
    readCommand: async () => handlerName(),
    describe: name => name,

    /** Save the handler set now (if any, and not this app). Returns false when there was nothing. */
    async backup(file) {
      const before = others(valueIn(readIfThere(listFile()), DEFAULTS, MIME));
      if (!before.length) return false;
      writeWhole(file, `${before.join(';')}\n`);
      return true;
    },

    /** Stop being the handler and put back the saved one, if there is one. */
    async restore(file) {
      const saved = file ? readIfThere(file).trim() : '';
      let text = readIfThere(listFile());
      if (text) {
        const added = others(valueIn(text, ADDED, MIME));
        text = withValue(text, DEFAULTS, MIME, saved);
        text = withValue(text, ADDED, MIME, added.length ? `${added.join(';')};` : '');
        writeWhole(listFile(), text);
      }
      release();
      return !!saved;
    },
  };
}

module.exports = { linuxNxm, execLine, MARK };
