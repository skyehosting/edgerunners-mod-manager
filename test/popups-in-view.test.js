'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/*
 * Pop-up menus placed by CSS next to their button (the Mods ⋯ menu opens to the right of it) ran off
 * the page in a narrow window: cut off, with a sideways scrollbar under the page. Each one is moved
 * back inside what can be seen as it opens (keepInView); the right-click and profile menus place
 * themselves at the pointer, already kept inside the window.
 */
const dir = path.join(__dirname, '..', 'src', 'renderer');
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

test('every pop-up placed next to its button is kept inside the window as it opens', () => {
  const app = read('app.js');
  assert.match(app, /^function keepInView\(el, anchor = null, pad = 8\) \{/m, 'the helper is in app.js, loaded before the other pages');
  const opens = [
    ['app.js', /function menuButton[\s\S]*?menu\.hidden = false;\s*keepInView\(menu, btn\);/, 'the ⋯ menus (Mods)'],
    ['groupspage.js', /menu\.hidden = false; keepInView\(menu, btn\);/, 'the Group Mods ⋯ menu'],
    ['gamelog.js', /\$\('#gl-play-menu'\)\.hidden = false;\s*keepInView\(\$\('#gl-play-menu'\), \$\('#gl-play-btn'\)\);/, 'the Game log play menu'],
    ['savespage.js', /pick\.hidden = false;\s*keepInView\(pick\);/, 'the Saves Copy to / Move to box'],
  ];
  for (const [f, re, what] of opens) assert.match(read(f), re, `${what} (${f})`);
  // Its arithmetic (FitBox, tested in fitbox.test.js) is loaded before app.js.
  const html = read('index.html');
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.ok(order.indexOf('../shared/fitbox.js') >= 0 && order.indexOf('../shared/fitbox.js') < order.indexOf('app.js'), 'fitbox.js loads before app.js');
  assert.match(app, /FitBox\.fitBox\(/);
  // A new pop-up placed by CSS next to its button needs the same call when it opens.
  const css = read('styles.css');
  assert.match(css, /\.menu\.menu-left \{ left: 0; right: auto; \}/, 'the Mods ⋯ menu still opens to the right of its button, so it needs moving back');
});
