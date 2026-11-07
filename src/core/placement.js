'use strict';
const fs = require('fs');
const path = require('path');
const { caseResolver } = require('./fileCase');

/*
 * Placing a download's files by hand (the "Place files" window), for an archive the layout rules
 * can't read. The window only proposes { src, dest } pairs; everything here is checked again in the
 * main process before anything is staged:
 *   - src must be a file of that download;
 *   - dest must be a plain path inside the game folder (no "..", drive, reserved or odd names);
 *   - no two files may go to one place, and no file where another goes as a folder;
 *   - nothing may replace a game file, or go where the game folder has a file in the way;
 *   - nothing may go through a link (junction, symlink) to a folder outside the game folder.
 * A file another mod already put there is allowed: that is an ordinary mod conflict, settled by
 * priority and the conflict window, and the other mod's file comes back when this one is off.
 */

// Where mods go: the "Mod folders" view of the game folder lists these.
const MOD_ROOTS = [
  'archive/pc/mod',
  'bin/x64/plugins/cyber_engine_tweaks/mods',
  'r6/scripts',
  'r6/tweaks',
  'red4ext/plugins',
  'mods',
  'bin/x64/plugins',
  'engine/config/platform/pc',
  'r6/input',
];

const MAX_FILES = 5000; // more than that is no job for a window
const MAX_LIST = 3000;  // entries shown for one folder of the game
const BAD_CHARS = /[<>:"|?*\\\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[\d\u00b9\u00b2\u00b3]|lpt[\d\u00b9\u00b2\u00b3]|clock\$|conin\$|conout\$)(\..*)?$/i;
const INVISIBLE = /[\p{Cf}\u00a0]/u; // direction marks and the like: a name that reads as another

/** A destination as a clean '/'-separated path inside the game folder, or null. */
function cleanDest(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 400) return null;
  const segs = raw.replace(/\\/g, '/').split('/');
  if (segs.some(s => !s || s === '.' || s === '..' || s.length > 200 || BAD_CHARS.test(s) || INVISIBLE.test(s) || /[. ]$/.test(s) || RESERVED.test(s))) return null;
  return segs.join('/');
}

/** A folder path inside the game folder ('' is its top), or null. */
function cleanDir(raw) {
  if (raw === '' || raw == null) return '';
  return cleanDest(raw);
}

const stat = p => { try { return fs.statSync(p); } catch { return null; } };
const real = p => { try { return fs.realpathSync.native(p); } catch { return null; } };
/** Is `p` (which exists) really inside the game folder, links followed? */
function staysInside(gameDir, p) {
  const top = real(gameDir);
  const at = real(p);
  if (!top || !at) return false;
  const rel = path.relative(top, at);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
/** Who put the file at `rel` there: a mod's id from the deployment record, or '' (the game, or a hand-made change). */
const ownerFrom = deployed => rel => deployed?.[rel.toLowerCase()]?.owner || '';

/**
 * What is at `rel` in the game folder now: 'free', 'mod' (a file a mod put there: owner given),
 * 'game' (a file of the game, or one no mod of this app owns), 'blocked' (a folder there, or a file
 * where a folder of the path must go).
 */
function spotState(gameDir, rel, ownerOf, where = caseResolver(gameDir)) {
  if (!gameDir) return { state: 'free' };
  const onDisk = where.resolve(rel, false);
  const parts = onDisk.split('/');
  for (let i = 1; i < parts.length; i++) {
    const p = path.join(gameDir, ...parts.slice(0, i));
    const s = stat(p);
    if (!s) break;
    if (!s.isDirectory()) return { state: 'blocked', at: parts.slice(0, i).join('/') };
    if (!staysInside(gameDir, p)) return { state: 'outside', at: parts.slice(0, i).join('/') };
  }
  const full = path.join(gameDir, ...parts);
  const s = stat(full);
  if (!s) return { state: 'free' };
  if (s.isDirectory()) return { state: 'blocked', at: onDisk };
  if (!staysInside(gameDir, full)) return { state: 'outside', at: onDisk };
  const owner = ownerOf(rel);
  return owner ? { state: 'mod', owner } : { state: 'game' };
}

/**
 * Check proposed pairs against the download's files and the game folder.
 * Returns { mappings (clean), problems: [{ src, dest, kind, text }], mods: { dest: ownerId } }.
 */
function checkPlacement({ pairs, files, gameDir, deployed, ownerOf = ownerFrom(deployed) }) {
  const have = new Set(files);
  const problems = [];
  const mappings = [];
  const mods = {};
  const seenSrc = new Set();
  const byDest = new Map();
  if (!Array.isArray(pairs)) return { mappings, problems: [{ kind: 'bad', text: 'No placement was given.' }], mods };
  if (pairs.length > MAX_FILES) return { mappings, problems: [{ kind: 'bad', text: `More than ${MAX_FILES} files.` }], mods };
  const where = gameDir ? caseResolver(gameDir) : null;
  for (const p of pairs) {
    const src = typeof p?.src === 'string' ? p.src : '';
    const dest = cleanDest(p?.dest);
    if (!have.has(src)) { problems.push({ src, dest: p?.dest, kind: 'bad', text: `${src || 'A file'} is not in this download.` }); continue; }
    if (seenSrc.has(src)) { problems.push({ src, dest, kind: 'bad', text: `${src} is placed twice.` }); continue; }
    seenSrc.add(src);
    if (!dest) { problems.push({ src, dest: p?.dest, kind: 'bad', text: `${src}: "${p?.dest}" is not a name that can go in the game folder.` }); continue; }
    const key = dest.toLowerCase();
    if (byDest.has(key)) { problems.push({ src, dest, kind: 'dup', text: `${src} and ${byDest.get(key)} would both go to ${dest}.` }); continue; }
    byDest.set(key, src);
    mappings.push({ src, dest });
  }
  // A file where another file's folder must go ("a" and "a/b").
  const destKeys = new Set(byDest.keys());
  for (const m of mappings) {
    const parts = m.dest.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      const up = parts.slice(0, i).join('/');
      if (destKeys.has(up)) problems.push({ src: m.src, dest: m.dest, kind: 'nest', text: `${m.dest} needs a folder where ${byDest.get(up)} goes as a file.` });
    }
  }
  if (where) {
    for (const m of mappings) {
      const st = spotState(gameDir, m.dest, ownerOf, where);
      if (st.state === 'game') problems.push({ src: m.src, dest: m.dest, kind: 'game', text: `${m.dest} is a game file: it can't be replaced.` });
      else if (st.state === 'outside') problems.push({ src: m.src, dest: m.dest, kind: 'outside', text: `${st.at} links to a folder outside the game folder: files can't be placed there by hand.` });
      else if (st.state === 'blocked') problems.push({ src: m.src, dest: m.dest, kind: 'blocked', text: `${m.dest}: the game folder has ${st.at === where.resolve(m.dest, false) ? 'a folder' : `a file (${st.at})`} in the way.` });
      else if (st.state === 'mod') mods[m.dest] = st.owner;
    }
  }
  return { mappings, problems, mods };
}

/**
 * One folder of the game folder, for the window's tree: { dirs: [name], files: [{ name, owner }], more }.
 * Only inside the game folder; files a mod of this app put there carry that mod's id.
 */
function listGameDir(gameDir, rel, deployed) {
  const empty = { dirs: [], files: [], more: 0 };
  if (!gameDir) return empty;
  const dir = cleanDir(rel);
  if (dir == null) throw new Error('Not a folder inside the game folder.');
  const where = caseResolver(gameDir);
  const onDisk = dir ? where.resolve(dir, false) : '';
  const full = path.join(gameDir, ...onDisk.split('/').filter(Boolean));
  const inside = path.relative(path.resolve(gameDir), path.resolve(full));
  if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Not a folder inside the game folder.');
  if (!stat(full)) return empty;
  if (!staysInside(gameDir, full)) return { ...empty, outside: true }; // a link out of the game folder is never listed
  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return empty; }
  const dirs = [];
  const files = [];
  let more = 0;
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))) {
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) isDir = !!stat(path.join(full, e.name))?.isDirectory();
    if (dirs.length + files.length >= MAX_LIST) { more++; continue; }
    if (isDir) dirs.push(e.name);
    else {
      const key = (onDisk ? `${onDisk}/${e.name}` : e.name).toLowerCase();
      files.push({ name: e.name, owner: deployed?.[key]?.owner || '' });
    }
  }
  return { dirs, files, more };
}

module.exports = { MOD_ROOTS, MAX_FILES, cleanDest, cleanDir, spotState, checkPlacement, listGameDir };
