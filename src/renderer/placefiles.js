'use strict';
/* global api, h, icon, withModal, showModal, toast, fmtSize, plural, state */
// The Place files window: an install whose files are in no place the app knows. The download's files
// on the left (Name | Size | Destination), the game folder on the right; files are placed by
// dragging, or by selecting them and pressing "Place in <folder>". Game files and other mods' files
// are read-only; folders made here, and this mod's files, can be renamed or removed until Apply.
// The main process checks every place again before anything is staged (src/core/placement.js).

(() => {
  const SEP = api.platform === 'win32' ? '\\' : '/';
  const shown = p => p.split('/').join(SEP);
  const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = p => p.slice(p.lastIndexOf('/') + 1);
  const lc = s => s.toLowerCase();
  const join = (d, n) => (d ? `${d}/${n}` : n);
  const under = (p, d) => !d || lc(p).startsWith(`${lc(d)}/`);
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const DOC = /\.(txt|md|pdf|png|jpe?g|gif|webp|bmp|url|html?|rtf|docx?|psd|mp4|webm)$/i;
  const CODE = /\.(lua|reds|js|ts|py|ya?ml|toml|json|ini|xml|tweak|cfg)$/i;
  const fileIcon = n => (/\.(archive|xl)$/i.test(n) ? 'package' : CODE.test(n) ? 'file-code' : 'file');
  // A name a folder or file may have in the game folder (the main process checks again).
  const badName = n => !n || n === '.' || n === '..' || n.length > 200 || /[<>:"/\\|?*\x00-\x1f\p{Cf}\u00a0]/u.test(n) || /[. ]$/.test(n) || /^(con|prn|aux|nul|com[\d\u00b9\u00b2\u00b3]|lpt[\d\u00b9\u00b2\u00b3]|clock\$|conin\$|conout\$)(\..*)?$/i.test(n);
  const PROBLEM = { game: 'Game file there', blocked: 'Blocked', dup: 'Two files here', nest: 'Clash', bad: 'Not allowed', outside: 'Outside the game' };

  // Sent again when the window reloads: one window per install, never two.
  const opened = new Set();
  api.onPlace(req => {
    if (!req?.token || opened.has(req.token)) return;
    opened.add(req.token);
    withModal(() => placeWindow(req)).finally(() => opened.delete(req.token));
  });

  function placeWindow(req) {
    const token = req.token;
    const files = req.files || [];
    const sizeOf = new Map(files.map(f => [f.path, f.size]));
    const preset = req.preset || {};
    const roots = req.roots || [];

    // ---- the download as a tree
    const ldirs = new Map(); // folder → { dirs: Set, files: [] }
    const lnode = d => { if (!ldirs.has(d)) ldirs.set(d, { dirs: new Set(), files: [] }); return ldirs.get(d); };
    lnode('');
    for (const f of files) {
      lnode(dirOf(f.path)).files.push(f.path);
      for (let c = dirOf(f.path); c; c = dirOf(c)) lnode(dirOf(c)).dirs.add(c);
    }
    for (const n of ldirs.values()) n.files.sort((a, b) => byName(baseOf(a), baseOf(b)));
    const filesUnderMemo = new Map();
    const filesUnder = d => {
      if (!filesUnderMemo.has(d)) filesUnderMemo.set(d, files.map(f => f.path).filter(p => p.startsWith(`${d}/`)));
      return filesUnderMemo.get(d);
    };

    // ---- state
    const startPlaces = () => new Map(files.map(f => [f.path, preset[f.path] || (DOC.test(f.path) ? 'out' : undefined)]).filter(([, d]) => d));
    let dest = startPlaces();          // file → game path, or 'out'
    let made = new Map();              // folders made here: lower-case path → path
    const sel = new Set();             // selected download files
    const selDirs = new Set();         // download folders selected as folders: placed with their name
    let anchor = null;                 // where a shift-click range starts (a file or folder path)
    const lclosed = new Set();         // download folders folded away
    let target = null;                 // the folder files go into ("Place in …")
    let rsel = null;                   // the selected game-folder row: { kind: 'dir' | 'file', path }
    let view = 'mods';
    const ropen = new Set();           // open game folders (lower case)
    const listing = new Map();         // lower-case folder → { dirs, files, more } | 'loading'
    const showFiles = new Set();       // folders whose existing files are listed
    let check = { problems: [], mods: {} };
    let checkGen = 0;
    let renaming = null;               // { kind, path } being renamed
    let menu = null;
    let dragging = null;
    let applyError = '';
    let applying = false;
    let changed = false;

    const placed = () => [...dest].filter(([, d]) => d !== 'out').map(([src, d]) => ({ src, dest: d }));
    const reveal = p => { for (let c = p; c; c = dirOf(c)) ropen.add(lc(c)); };
    for (const { dest: d } of placed()) reveal(dirOf(d));

    // ---- what is in the game folder
    function load(dir) {
      const key = lc(dir);
      if (listing.has(key)) return listing.get(key);
      listing.set(key, 'loading');
      api.placeList(token, dir).then(r => { listing.set(key, r?.ok || { dirs: [], files: [], more: 0 }); paint(); });
      return 'loading';
    }
    const isReal = p => {
      const l = listing.get(lc(dirOf(p)));
      if (!l || l === 'loading') return true; // not known: never offered for renaming
      return l.dirs.some(n => lc(n) === lc(baseOf(p)));
    };
    const isRoot = p => view === 'mods' && roots.some(r => lc(r) === lc(p));
    // A folder this window made, or one only this mod's files need: its name can change until Apply.
    const editableDir = p => !!p && !isRoot(p) && !isReal(p) && (made.has(lc(p)) || placed().some(m => under(m.dest, p)));

    /** Folders and files to show in one game folder: what is there, plus what this window adds. */
    function children(dir) {
      const real = load(dir);
      const dirs = new Map();
      if (real !== 'loading') for (const n of real.dirs) dirs.set(lc(n), { name: n, real: true });
      const add = q => {
        if (!under(q, dir)) return;
        const name = q.slice(dir ? dir.length + 1 : 0).split('/')[0];
        if (!dirs.has(lc(name))) dirs.set(lc(name), { name, real: false });
      };
      for (const p of made.values()) add(p);
      for (const x of placed()) if (lc(dirOf(x.dest)) !== lc(dir)) add(dirOf(x.dest));
      const mine = placed().filter(m => lc(dirOf(m.dest)) === lc(dir)).sort((a, b) => byName(baseOf(a.dest), baseOf(b.dest)));
      const mineKeys = new Set(mine.map(m => lc(baseOf(m.dest))));
      const others = real === 'loading' ? [] : real.files.filter(f => !mineKeys.has(lc(f.name)));
      return { loading: real === 'loading', dirs: [...dirs.values()].sort((a, b) => byName(a.name, b.name)), mine, others, more: real === 'loading' ? 0 : real.more };
    }

    // ---- changes
    function touch() {
      changed = true;
      applyError = '';
      const gen = ++checkGen;
      paint();
      clearTimeout(touch.t);
      touch.t = setTimeout(async () => {
        const r = await api.placeCheck(token, placed());
        if (gen !== checkGen || !r?.ok) return;
        check = r.ok;
        paint();
      }, 120);
    }

    /**
     * The selection into `into`, as a file browser does it: a selected folder goes in with its name
     * and everything inside it; files picked one by one go in loose.
     */
    function placeSelection(into) {
      if (into == null || !sel.size) return;
      for (const f of sel) {
        let top = '';
        for (let c = dirOf(f); c; c = dirOf(c)) if (selDirs.has(c)) top = c;
        dest.set(f, join(into, top ? f.slice(dirOf(top) ? dirOf(top).length + 1 : 0) : baseOf(f)));
        reveal(dirOf(dest.get(f)));
      }
      target = into;
      clearSel();
      touch();
    }
    const clearSel = () => { sel.clear(); selDirs.clear(); };
    // The folder rows inside `d` (and `d`) as folders, or none of them.
    const markDirs = (d, on) => { for (const x of [d, ...[...ldirs.keys()].filter(k => k.startsWith(`${d}/`))]) on ? selDirs.add(x) : selDirs.delete(x); };
    // A file taken out of a selected folder: its folders are no longer selected whole.
    const unmarkUp = f => { for (let c = dirOf(f); c; c = dirOf(c)) selDirs.delete(c); };
    const leaveOut = list => { for (const f of list) dest.set(f, 'out'); clearSel(); touch(); };
    const unplace = list => { for (const f of list) dest.delete(f); touch(); };

    /** Move or rename a folder of this mod's: its files and the folders made inside it go along. */
    function moveDir(from, to) {
      for (const [f, d] of dest) if (d !== 'out' && under(d, from)) dest.set(f, to + d.slice(from.length));
      const next = new Map();
      for (const p of made.values()) {
        const q = lc(p) === lc(from) || under(p, from) ? to + p.slice(from.length) : p;
        next.set(lc(q), q);
      }
      made = next;
      if (!made.has(lc(to)) && !placed().some(m => under(m.dest, to))) made.set(lc(to), to);
      for (const k of [...ropen]) if (k === lc(from) || k.startsWith(`${lc(from)}/`)) { ropen.delete(k); ropen.add(lc(to) + k.slice(from.length)); }
      if (target && (lc(target) === lc(from) || under(target, from))) target = to + target.slice(from.length);
      reveal(to);
      touch();
    }
    function moveFile(src, toDir) {
      dest.set(src, join(toDir, baseOf(dest.get(src))));
      reveal(toDir);
      touch();
    }
    function removeDir(p) {
      for (const [f, d] of dest) if (d !== 'out' && under(d, p)) dest.delete(f);
      for (const [k, q] of made) if (lc(q) === lc(p) || under(q, p)) made.delete(k);
      if (target && (lc(target) === lc(p) || under(target, p))) target = dirOf(p) || null;
      rsel = null;
      touch();
    }
    function newFolder() {
      const parent = rsel?.kind === 'dir' ? rsel.path : target;
      if (parent == null) return;
      const taken = new Set(children(parent).dirs.map(d => lc(d.name)));
      let name = 'New folder';
      for (let i = 2; taken.has(lc(name)); i++) name = `New folder (${i})`;
      const p = join(parent, name);
      made.set(lc(p), p);
      reveal(p);
      ropen.add(lc(parent));
      rsel = { kind: 'dir', path: p };
      target = p;
      renaming = { kind: 'dir', path: p };
      touch();
    }
    const srcOfDest = d => [...dest].find(([, x]) => x === d)?.[0];
    function commitRename(value) {
      const r = renaming;
      renaming = null;
      const name = value.trim();
      if (!r || !name || name === baseOf(r.path)) { paint(); return; }
      if (badName(name)) { toast(`"${name}" can't be a name in the game folder`, 'error'); paint(); return; }
      const parent = dirOf(r.path);
      const c = children(parent);
      const clash = c.dirs.some(d => lc(d.name) === lc(name)) || c.mine.some(x => lc(baseOf(x.dest)) === lc(name)) || c.others.some(f => lc(f.name) === lc(name));
      if (clash && lc(name) !== lc(baseOf(r.path))) { toast(`${name} is already in that folder`, 'error'); paint(); return; }
      const to = join(parent, name);
      if (r.kind === 'dir') { moveDir(r.path, to); rsel = { kind: 'dir', path: to }; } else {
        const src = srcOfDest(r.path);
        if (src) dest.set(src, to);
        rsel = { kind: 'file', path: to };
        touch();
      }
    }
    const canEdit = () => !!rsel && (rsel.kind === 'file' ? !!srcOfDest(rsel.path) : editableDir(rsel.path));
    function removeSelected() {
      if (!canEdit()) return;
      if (rsel.kind === 'dir') removeDir(rsel.path);
      else { const src = srcOfDest(rsel.path); rsel = null; if (src) unplace([src]); }
    }

    // ---- the dialog
    const m = document.getElementById('modal');
    m.className = 'modal pf';
    m.setAttribute('aria-labelledby', 'pf-title');
    m.setAttribute('aria-describedby', 'pf-sub');
    let hide = null;
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });
    let escArmed = false;
    const finish = async ok => {
      closeMenu();
      if (!ok) { await api.placeCancel(token); }
      hide?.();
      m.classList.remove('pf');
      resolveDone();
    };
    const onDismiss = () => {
      if (menu) { closeMenu(); return; }
      if (!changed || escArmed) { finish(false); return; }
      escArmed = true;
      applyError = 'Press Esc again to cancel this install.';
      paint();
      setTimeout(() => { escArmed = false; if (applyError.startsWith('Press Esc')) { applyError = ''; paint(); } }, 3000);
    };
    async function apply() {
      if (applying) return;
      applying = true;
      paint();
      const r = await api.placeSubmit(token, placed());
      applying = false;
      if (r?.error) { applyError = r.error; paint(); return; }
      toast(`Installed ${req.name}`, 'success');
      finish(true);
    }

    function closeMenu() { menu?.remove(); menu = null; document.removeEventListener('pointerdown', menuAway, true); }
    function menuAway(ev) { if (menu && !menu.contains(ev.target)) closeMenu(); }
    function openMenu(anchorEl, items) {
      closeMenu();
      menu = h('div', { class: 'pf-menu', role: 'menu' }, items.filter(Boolean).map(it => h('button', {
        class: 'menu-item', role: 'menuitem', disabled: !!it.disabled,
        onclick: () => { closeMenu(); it.fn(); },
      }, icon(it.icon), h('span', {}, it.label))));
      menu.addEventListener('keydown', ev => {
        const items2 = [...menu.querySelectorAll('button:not(:disabled)')];
        const i = items2.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown') { ev.preventDefault(); items2[(i + 1) % items2.length]?.focus(); }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); items2[(i - 1 + items2.length) % items2.length]?.focus(); }
        if (ev.key === 'Escape') { ev.stopPropagation(); closeMenu(); anchorEl.focus(); }
      });
      m.append(menu);
      const a = anchorEl.getBoundingClientRect();
      const box = m.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(a.left - box.left, box.width - menu.offsetWidth - 8))}px`;
      const below = a.bottom - box.top + 4;
      menu.style.top = `${below + menu.offsetHeight > box.height - 8 ? a.top - box.top - menu.offsetHeight - 4 : below}px`;
      menu.querySelector('button:not(:disabled)')?.focus();
      document.addEventListener('pointerdown', menuAway, true);
    }

    // ---- left: the download
    const probBySrc = () => new Map(check.problems.filter(p => p.src).map(p => [p.src, p]));
    let leftOrder = [];
    function selectRow(path, isDir, ev) {
      const list = isDir ? filesUnder(path) : [path];
      if (ev.shiftKey && anchor != null) {
        const a = leftOrder.findIndex(r => r.path === anchor);
        const b = leftOrder.findIndex(r => r.path === path);
        if (a >= 0 && b >= 0) {
          if (!(ev.ctrlKey || ev.metaKey)) clearSel();
          for (const r of leftOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            if (r.dir) markDirs(r.path, true);
            (r.dir ? filesUnder(r.path) : [r.path]).forEach(f => sel.add(f));
          }
          paint();
          return;
        }
      }
      if (ev.ctrlKey || ev.metaKey) toggleCheck(path, isDir, false);
      else {
        clearSel();
        list.forEach(f => sel.add(f));
        if (isDir) markDirs(path, true);
      }
      anchor = path;
      paint();
    }
    function toggleCheck(path, isDir, repaint = true) {
      const list = isDir ? filesUnder(path) : [path];
      const all = list.every(f => sel.has(f)) && (!isDir || selDirs.has(path));
      list.forEach(f => (all ? sel.delete(f) : sel.add(f)));
      if (isDir) markDirs(path, !all);
      if (all) list.forEach(unmarkUp);
      anchor = path;
      if (repaint) paint();
    }
    function leftDrag(ev, path, isDir) {
      const list = isDir ? filesUnder(path) : [path];
      if (!list.every(f => sel.has(f)) || (isDir && !selDirs.has(path))) { clearSel(); list.forEach(f => sel.add(f)); if (isDir) markDirs(path, true); anchor = path; }
      dragging = { kind: 'left' };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', `${sel.size} files`);
      const ghost = h('div', { class: 'pf-ghost' }, icon('file'), `${plural(sel.size, 'file')}`);
      document.body.append(ghost);
      ev.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0); // repainting now would remove the row being dragged
    }

    function destCell(path, probs) {
      const d = dest.get(path);
      const prob = probs.get(path);
      const menuFor = el => openMenu(el, [
        target != null && { icon: 'arrow-down', label: `Place in ${baseOf(target) || 'the game folder'}`, fn: () => { clearSel(); sel.add(path); placeSelection(target); } },
        d && d !== 'out' && { icon: 'folder', label: 'Show in the game folder', fn: () => { reveal(dirOf(d)); rsel = { kind: 'file', path: d }; target = dirOf(d); paint(); scrollToRight(d); } },
        d !== 'out' && { icon: 'ban', label: 'Leave out', fn: () => leaveOut([path]) },
        d && { icon: 'rotate', label: d === 'out' ? 'Give it a place' : 'Take it back (not placed)', fn: () => unplace([path]) },
      ]);
      let body;
      let cls = 'pf-dest';
      if (d === undefined) { body = [h('span', { class: 'p' }, 'Not placed')]; cls += ' need'; } else if (d === 'out') {
        body = [h('span', { class: 'p' }, DOC.test(path) ? 'Left out (not a game file)' : 'Left out')];
        cls += ' quiet';
      } else {
        const dir = dirOf(d);
        // The folder it goes in ("archive\pc\" muted, "mod" bright); the whole path when it was renamed.
        const kids = baseOf(d) !== baseOf(path) ? [h('span', { class: 'd' }, dir ? `${shown(dir)}${SEP}` : ''), baseOf(d)]
          : dir ? [h('span', { class: 'd' }, dirOf(dir) ? `${shown(dirOf(dir))}${SEP}` : ''), baseOf(dir)] : ['The game folder'];
        body = [h('span', { class: 'p', title: shown(d) }, h('bdi', {}, ...kids))];
        if (prob) { cls += ' bad'; body.push(h('span', { class: 'how', title: prob.text }, icon('x-circle'), PROBLEM[prob.kind] || 'Problem')); } else if (check.mods[d]) { cls += ' clash'; body.push(h('span', { class: 'how', title: `${check.mods[d]} has a file here. Their order on the Mods page decides which one the game gets.` }, icon('alert'), 'Conflict')); } else if (preset[path] === d) body.push(h('span', { class: 'how' }, 'As last time'));
      }
      return h('button', {
        class: cls, type: 'button', tabIndex: -1, 'aria-haspopup': 'menu', 'aria-label': `Destination of ${baseOf(path)}`,
        onclick: ev => { ev.stopPropagation(); menuFor(ev.currentTarget); },
      }, ...body, icon('chevron', 'cv'));
    }

    function leftRows() {
      const rows = [];
      leftOrder = [];
      const probs = probBySrc();
      const walk = (dir, depth) => {
        const n = ldirs.get(dir);
        for (const d of [...n.dirs].sort((a, b) => byName(baseOf(a), baseOf(b)))) {
          const all = filesUnder(d);
          const k = all.filter(f => sel.has(f)).length;
          const open = !lclosed.has(d);
          leftOrder.push({ path: d, dir: true });
          rows.push(h('div', {
            class: `pf-row folder${k && k === all.length ? ' sel' : ''}`, role: 'treeitem', 'aria-level': String(depth + 1), 'aria-expanded': String(open),
            'aria-selected': String(k === all.length), tabIndex: -1, draggable: true, dataset: { key: `pf:l:${d}`, path: d, dir: '1' }, style: `--d:${depth}`,
            onclick: ev => selectRow(d, true, ev), ondragstart: ev => leftDrag(ev, d, true), ondragend: () => { dragging = null; paint(); },
          },
          h('span', { class: `pf-ck${k === all.length ? ' on' : k ? ' part' : ''}`, role: 'checkbox', 'aria-checked': k === all.length ? 'true' : k ? 'mixed' : 'false', 'aria-label': `Select ${baseOf(d)}`, onclick: ev => { ev.stopPropagation(); toggleCheck(d, true); } }, k === all.length ? icon('check') : null),
          h('span', { class: 'pf-name' },
            h('span', { class: 'tw', onclick: ev => { ev.stopPropagation(); open ? lclosed.add(d) : lclosed.delete(d); paint(); } }, icon(open ? 'chevron' : 'chevron-right')),
            icon('folder', 'fo'), h('span', { class: 'n', title: d }, baseOf(d))),
          h('span', { class: 'pf-size num' }, open ? '' : plural(all.length, 'file')),
          h('span')));
          if (open) walk(d, depth + 1);
        }
        for (const f of n.files) {
          const on = sel.has(f);
          const d = dest.get(f);
          leftOrder.push({ path: f, dir: false });
          rows.push(h('div', {
            class: `pf-row${on ? ' sel' : ''}${d === 'out' ? ' out' : ''}`, role: 'treeitem', 'aria-level': String(depth + 1), 'aria-selected': String(on),
            tabIndex: -1, draggable: true, dataset: { key: `pf:l:${f}`, path: f }, style: `--d:${depth}`,
            onclick: ev => selectRow(f, false, ev), ondragstart: ev => leftDrag(ev, f, false), ondragend: () => { dragging = null; paint(); },
          },
          h('span', { class: `pf-ck${on ? ' on' : ''}`, role: 'checkbox', 'aria-checked': String(on), 'aria-label': `Select ${baseOf(f)}`, onclick: ev => { ev.stopPropagation(); toggleCheck(f, false); } }, on ? icon('check') : null),
          h('span', { class: 'pf-name' }, h('span', { class: 'tw' }), icon(fileIcon(f), 'ico'), h('span', { class: 'n', title: f }, baseOf(f))),
          h('span', { class: 'pf-size num' }, fmtSize(sizeOf.get(f))),
          destCell(f, probs)));
        }
      };
      walk('', 0);
      return rows;
    }

    // ---- right: the game folder
    function scrollToRight(p) {
      requestAnimationFrame(() => m.querySelector(`.pf-gm [data-key="${CSS.escape(`pf:r:${lc(p)}`)}"]`)?.scrollIntoView({ block: 'nearest' }));
    }
    const dropProps = dir => ({
      ondragover: ev => {
        if (!dragging) return;
        if (dragging.kind === 'dir' && (lc(dir) === lc(dragging.path) || under(dir, dragging.path))) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        ev.currentTarget.classList.add('drop');
      },
      ondragleave: ev => ev.currentTarget.classList.remove('drop'),
      ondrop: ev => {
        ev.preventDefault();
        ev.currentTarget.classList.remove('drop');
        const d = dragging;
        dragging = null;
        if (!d) return;
        if (d.kind === 'left') placeSelection(dir);
        else if (d.kind === 'file') { const src = srcOfDest(d.path); if (src && lc(dirOf(d.path)) !== lc(dir)) moveFile(src, dir); }
        else if (d.kind === 'dir' && lc(dirOf(d.path)) !== lc(dir)) moveDir(d.path, join(dir, baseOf(d.path)));
      },
    });
    function rightDrag(ev, kind, p) {
      dragging = { kind, path: p };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', baseOf(p));
    }
    function renameInput(p) {
      const input = h('input', {
        class: 'pf-rename', value: baseOf(p), 'aria-label': 'New name', spellcheck: false,
        onkeydown: ev => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { ev.preventDefault(); commitRename(input.value); }
          if (ev.key === 'Escape') { ev.preventDefault(); renaming = null; paint(); }
        },
        onblur: () => { if (renaming) commitRename(input.value); },
        onclick: ev => ev.stopPropagation(),
      });
      requestAnimationFrame(() => { input.focus(); const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, renaming?.kind === 'file' && dot > 0 ? dot : input.value.length); });
      return input;
    }
    function rightRows() {
      const rows = [];
      const probsByDest = new Map(check.problems.filter(p => p.dest).map(p => [lc(String(p.dest)), p]));
      const dirRow = (p, label, depth, info) => {
        const open = ropen.has(lc(p));
        const isTarget = target != null && lc(target) === lc(p);
        const editable = editableDir(p);
        const mine = !info.real || placed().some(x => under(x.dest, p));
        const isSel = rsel?.kind === 'dir' && lc(rsel.path) === lc(p);
        rows.push(h('div', {
          class: `pf-row${editable ? ' mine' : ' ro'}${isTarget ? ' target' : ''}${isSel ? ' rsel' : ''}`, role: 'treeitem', 'aria-level': String(depth + 1),
          'aria-expanded': String(open), 'aria-selected': String(isTarget), tabIndex: -1, draggable: editable, style: `--d:${depth}`,
          dataset: { key: `pf:r:${lc(p)}`, path: p, dir: '1' },
          onclick: () => { rsel = { kind: 'dir', path: p }; target = p; paint(); },
          ondblclick: () => { open ? ropen.delete(lc(p)) : ropen.add(lc(p)); paint(); },
          ondragstart: editable ? ev => rightDrag(ev, 'dir', p) : null, ondragend: () => { dragging = null; },
          ...dropProps(p),
        },
        h('span', { class: 'pf-name' },
          h('span', { class: 'tw', onclick: ev => { ev.stopPropagation(); open ? ropen.delete(lc(p)) : ropen.add(lc(p)); paint(); } }, icon(open ? 'chevron' : 'chevron-right')),
          icon('folder', `fo${mine && editable ? ' acc' : ''}`),
          renaming?.kind === 'dir' && lc(renaming.path) === lc(p) ? renameInput(p) : h('span', { class: 'n', title: shown(p) }, label)),
        h('span', { class: 'm' }, editable ? h('span', { class: 'pf-tag' }, 'New') : h('span', { class: 'lk', title: 'Part of the game or of other mods: read-only' }, icon('lock')))));
        if (open) walk(p, depth + 1);
      };
      const walk = (dir, depth) => {
        const c = children(dir);
        if (c.loading) { rows.push(h('div', { class: 'pf-row ro note', style: `--d:${depth}` }, h('span', { class: 'pf-name' }, h('span', { class: 'tw' }), h('span', { class: 'n' }, 'Loading…')))); return; }
        for (const d of c.dirs) {
          const p = join(dir, d.name);
          // "Mod folders": a folder that leads to another of them is shown there, not twice.
          if (view === 'mods' && roots.some(r => lc(r) === lc(p) || under(r, p))) continue;
          dirRow(p, d.name, depth, d);
        }
        for (const x of c.mine) {
          const src = srcOfDest(x.dest);
          const prob = probsByDest.get(lc(x.dest));
          const clash = check.mods[x.dest];
          const isSel = rsel?.kind === 'file' && rsel.path === x.dest;
          rows.push(h('div', {
            class: `pf-row mine${prob ? ' bad' : clash ? ' warn' : ''}${isSel ? ' rsel' : ''}`, role: 'treeitem', 'aria-level': String(depth + 1), tabIndex: -1,
            draggable: true, style: `--d:${depth}`, dataset: { key: `pf:r:${lc(x.dest)}`, path: x.dest },
            onclick: () => { rsel = { kind: 'file', path: x.dest }; target = dir; paint(); },
            ondragstart: ev => rightDrag(ev, 'file', x.dest), ondragend: () => { dragging = null; },
          },
          h('span', { class: 'pf-name' }, h('span', { class: 'tw' }), icon(fileIcon(x.dest), 'ico'),
            renaming?.kind === 'file' && renaming.path === x.dest ? renameInput(x.dest) : h('span', { class: 'n', title: src ? `From ${src}` : '' }, baseOf(x.dest))),
          h('span', { class: 'm' }, prob ? [icon('x-circle'), h('span', { title: prob.text }, PROBLEM[prob.kind] || 'Problem')] : clash ? [icon('alert'), `Also in ${clash}`] : '')));
        }
        if (c.others.length) {
          const open = showFiles.has(lc(dir));
          const ownersN = c.others.filter(f => f.owner).length;
          const what = ownersN === c.others.length ? 'from other mods' : ownersN ? 'from the game and other mods' : 'of the game';
          rows.push(h('div', {
            class: 'pf-row ro more', tabIndex: -1, role: 'treeitem', 'aria-level': String(depth + 1), 'aria-expanded': String(open), style: `--d:${depth}`,
            dataset: { key: `pf:r:more:${lc(dir)}` }, onclick: () => { open ? showFiles.delete(lc(dir)) : showFiles.add(lc(dir)); paint(); }, ...dropProps(dir),
          },
          h('span', { class: 'pf-name' }, h('span', { class: 'tw' }, icon(open ? 'chevron' : 'chevron-right')), icon('file', 'ico'), h('span', { class: 'n' }, `${plural(c.others.length, 'file')} ${what}`)),
          h('span', { class: 'm' }, h('span', { class: 'lk' }, icon('lock')))));
          if (open) {
            for (const f of c.others) {
              rows.push(h('div', { class: 'pf-row ro', style: `--d:${depth + 1}`, role: 'treeitem', 'aria-level': String(depth + 2), ...dropProps(dir) },
                h('span', { class: 'pf-name' }, h('span', { class: 'tw' }), icon(fileIcon(f.name), 'ico'), h('span', { class: 'n' }, f.name)),
                h('span', { class: 'm' }, f.owner ? (state?.snap?.mods || []).find(x => x.id === f.owner)?.name || 'Another mod' : 'Game file')));
            }
            if (c.more) rows.push(h('div', { class: 'pf-row ro note', style: `--d:${depth + 1}` }, h('span', { class: 'pf-name' }, h('span', { class: 'tw' }), h('span', { class: 'n' }, `and ${c.more} more`))));
          }
        }
      };
      if (view === 'mods') {
        const extra = new Map();
        for (const q of [...made.values(), ...placed().map(x => dirOf(x.dest))]) {
          if (!q || roots.some(r => lc(q) === lc(r) || under(q, r))) continue;
          const top = q.split('/')[0];
          extra.set(lc(top), top);
        }
        for (const r of [...roots, ...extra.values()]) dirRow(r, shown(r), 0, { real: true });
      } else walk('', 0);
      return rows;
    }

    // ---- keyboard in the two lists
    function listKeys(ev, side) {
      const list = ev.currentTarget;
      const rows = [...list.querySelectorAll('.pf-row[tabindex]')];
      const row = document.activeElement?.closest?.('.pf-row');
      const i = rows.indexOf(row);
      const go = j => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; r?.focus(); };
      const path = row?.dataset.path;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); go(i + 1); } else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(i - 1); } else if (ev.key === 'Home') { ev.preventDefault(); go(0); } else if (ev.key === 'End') { ev.preventDefault(); go(rows.length - 1); } else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && row?.dataset.dir) {
        ev.preventDefault();
        const openIt = ev.key === 'ArrowRight';
        if (side === 'l') { if (openIt) lclosed.delete(path); else lclosed.add(path); } else if (openIt) ropen.add(lc(path)); else ropen.delete(lc(path));
        paint();
      } else if (ev.key === ' ' && path && side === 'l') { ev.preventDefault(); toggleCheck(path, !!row.dataset.dir); } else if (ev.key === 'Enter' && path) {
        ev.preventDefault();
        if (side === 'l') { if (sel.size && target != null) placeSelection(target); } else row.click();
      } else if (side === 'r' && ev.key === 'F2' && canEdit()) { ev.preventDefault(); renaming = { ...rsel }; paint(); } else if (side === 'r' && ev.key === 'Delete' && canEdit()) { ev.preventDefault(); removeSelected(); }
    }
    function focusRow(ev) {
      const row = ev.target.closest('.pf-row[tabindex]');
      if (!row) return;
      ev.currentTarget.querySelectorAll('.pf-row[tabindex="0"]').forEach(r => { if (r !== row) r.tabIndex = -1; });
      row.tabIndex = 0;
    }

    // "3 files selected", or "NeonOverlay folder (3 files)": what Place in will move.
    function selWords() {
      const tops = [...selDirs].filter(d => !selDirs.has(dirOf(d)) || !dirOf(d)).filter(d => ![...selDirs].some(o => o !== d && d.startsWith(`${o}/`)));
      const loose = [...sel].filter(f => !tops.some(t => f.startsWith(`${t}/`))).length;
      const parts = [];
      if (tops.length === 1) parts.push(h('b', {}, baseOf(tops[0])), ' folder');
      else if (tops.length) parts.push(h('b', { class: 'num' }, String(tops.length)), ' folders');
      if (tops.length && loose) parts.push(' and ');
      if (loose) parts.push(h('b', { class: 'num' }, String(loose)), loose === 1 ? ' file' : ' files');
      parts.push(tops.length ? ` (${plural(sel.size, 'file')}) selected` : ' selected');
      return parts;
    }

    // ---- paint
    let leftList = null;
    let rightList = null;
    function paint() {
      const lScroll = leftList?.scrollTop || 0;
      const rScroll = rightList?.scrollTop || 0;
      const active = document.activeElement;
      const activeKey = m.contains(active) ? active.closest('[data-key]')?.dataset.key || active.id : null;
      const total = files.length;
      const decided = [...dest.values()].length;
      const need = total - decided;
      const nPlaced = placed().length;
      const conflicts = Object.keys(check.mods).length;
      const problems = check.problems.length;
      const tname = target != null ? (baseOf(target) || 'the game folder') : '';

      leftList = h('div', { class: 'pf-list', role: 'tree', 'aria-label': 'Files in the download', 'aria-multiselectable': 'true', onkeydown: ev => listKeys(ev, 'l'), onfocusin: focusRow }, leftRows());
      rightList = h('div', { class: 'pf-list', role: 'tree', 'aria-label': 'The game folder', onkeydown: ev => listKeys(ev, 'r'), onfocusin: focusRow }, rightRows());
      for (const list of [leftList, rightList]) { const first = list.querySelector('.pf-row[tabindex]'); if (first) first.tabIndex = 0; }

      const dl = req.fileName || req.name;
      m.replaceChildren(
        h('header', { class: 'pf-hd' },
          h('div', { class: 'tt' },
            h('h3', { id: 'pf-title' }, `Place files: ${req.name}`),
            h('p', { id: 'pf-sub' }, h('b', {}, dl), ' doesn\'t match a known mod layout. Choose where each file goes. Nothing is written to the game until you apply.')),
          h('div', { class: 'pf-status', role: 'status' },
            h('span', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${total ? Math.round((decided / total) * 100) : 0}%` })),
            h('span', { class: 'num' }, need ? [h('b', {}, String(need)), ` ${need === 1 ? 'file needs' : 'files need'} a place`] : 'Every file has a place'),
            problems ? h('span', { class: 'e' }, icon('x-circle'), plural(problems, 'problem')) : null,
            conflicts ? h('span', { class: 'w' }, icon('alert'), plural(conflicts, 'conflict')) : null),
          h('button', { class: 'btn btn-ghost btn-icon pf-x', 'aria-label': 'Cancel this install', title: 'Cancel', onclick: () => onDismiss() }, icon('x'))),
        h('div', { class: 'pf-body' },
          h('section', { class: 'pf-pane pf-dl', 'aria-label': 'The download' },
            h('div', { class: 'pf-ph' },
              h('div', { class: 't' }, h('b', {}, 'Download'), h('span', { class: 'num' }, `${dl} · ${plural(total, 'file')} · ${fmtSize(files.reduce((s, f) => s + (f.size || 0), 0))}`)),
              h('div', { class: 'tools' }, h('button', {
                class: 'btn btn-ghost btn-sm', dataset: { key: 'pf:all' },
                onclick: () => { const all = sel.size === total; clearSel(); if (!all) files.forEach(f => sel.add(f.path)); paint(); },
              }, sel.size === total ? 'Select none' : 'Select all'))),
            h('div', { class: 'pf-th', 'aria-hidden': 'true' }, h('span'), h('span', {}, 'Name'), h('span', { class: 'r' }, 'Size'), h('span', {}, 'Destination')),
            leftList,
            h('div', { class: 'pf-selbar' },
              h('span', { class: 'c' }, sel.size ? selWords() : 'Select files, then a folder on the right'),
              h('span', { class: 'sp' }),
              h('button', { class: 'btn btn-ghost', disabled: !sel.size, dataset: { key: 'pf:out' }, onclick: () => leaveOut([...sel]) }, 'Leave out'),
              h('button', {
                class: 'btn btn-primary', disabled: !sel.size || target == null, dataset: { key: 'pf:place' },
                title: target == null ? 'Select a folder on the right first' : `Put the selected files in ${shown(target) || 'the game folder'}`,
                onclick: () => placeSelection(target),
              }, h('span', {}, target != null ? ['Place in ', h('b', {}, tname)] : 'Place in…'), icon('arrow-right')))),
          h('section', { class: 'pf-pane pf-gm', 'aria-label': 'The game folder' },
            h('div', { class: 'pf-ph' },
              h('div', { class: 't' }, h('b', {}, 'Cyberpunk 2077'), h('span', { title: req.gameDir || '' }, req.gameDir || 'The game folder is not set: folders are shown as they will be made')),
              h('div', { class: 'tools' },
                h('button', { class: 'btn btn-ghost btn-icon', title: 'New folder', 'aria-label': 'New folder', disabled: !(rsel?.kind === 'dir' || target != null), dataset: { key: 'pf:new' }, onclick: newFolder }, icon('folder-plus')),
                h('button', { class: 'btn btn-ghost btn-icon', title: 'Rename (F2): folders made here and this mod\'s files', 'aria-label': 'Rename', disabled: !canEdit(), dataset: { key: 'pf:ren' }, onclick: () => { renaming = { ...rsel }; paint(); } }, icon('edit')),
                h('button', { class: 'btn btn-ghost btn-icon', title: 'Remove (Delete): folders made here and this mod\'s files go back to the download', 'aria-label': 'Remove', disabled: !canEdit(), dataset: { key: 'pf:del' }, onclick: removeSelected }, icon('trash')),
                h('span', { class: 'pf-sep', 'aria-hidden': 'true' }),
                h('div', { class: 'seg seg-sm', role: 'group', 'aria-label': 'Show' },
                  ...[['mods', 'Mod folders'], ['all', 'All']].map(([v, label]) => h('button', {
                    class: `seg-btn${view === v ? ' active' : ''}`, 'aria-pressed': String(view === v), dataset: { key: `pf:view:${v}` },
                    onclick: () => { view = v; paint(); },
                  }, label))))),
            h('div', { class: 'pf-th', 'aria-hidden': 'true' }, h('span', {}, 'Name'), h('span')),
            rightList,
            h('div', { class: 'pf-pf' },
              h('span', { class: 'key' }, h('i'), 'This mod'),
              h('span', { class: 'sp' }),
              icon('lock'), h('span', {}, 'Game files and other mods are read-only')))),
        h('footer', { class: 'pf-ft' },
          h('button', { class: 'btn btn-ghost', disabled: !changed, dataset: { key: 'pf:reset' }, onclick: () => { dest = startPlaces(); made = new Map(); clearSel(); rsel = null; target = null; changed = false; touch(); changed = false; paint(); } }, icon('rotate'), h('span', {}, 'Start over')),
          h('span', { class: 'sp' }),
          h('span', { class: `note${applyError ? ' err' : ''}`, role: applyError ? 'alert' : null }, applyError || (need && nPlaced ? `${plural(need, 'file')} without a place will be left out` : '')),
          h('button', { class: 'btn', dataset: { key: 'pf:cancel' }, onclick: () => finish(false) }, 'Cancel'),
          h('button', {
            class: 'btn btn-primary', dataset: { key: 'pf:apply' }, disabled: applying || !nPlaced || problems > 0,
            title: problems ? 'Fix the problems first' : !nPlaced ? 'Place at least one file' : '', onclick: apply,
          }, applying ? 'Installing…' : 'Apply')),
      );
      if (menu) m.append(menu);
      leftList.scrollTop = lScroll;
      rightList.scrollTop = rScroll;
      if (activeKey && !renaming) (m.querySelector(`[data-key="${CSS.escape(activeKey)}"]`) || (activeKey && document.getElementById(activeKey)))?.focus({ preventScroll: true });
    }

    touch();
    changed = false;
    paint();
    hide = showModal({ focus: '.pf-dl .pf-row', onDismiss, backdrop: false });
    return done;
  }
})();
