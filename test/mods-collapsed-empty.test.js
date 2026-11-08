'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/*
 * Mods page with categories: every category collapsed hides every row, but the mods still match.
 * The "No matching mods" panel covers the whole card, category rows included, so if it showed then,
 * the click meant to open a category again landed on the panel and the list stayed shut (the
 * collapsed state is saved, so a restart didn't help either). The panel follows the mods that match
 * the search and filters, counted before collapsed categories are left out.
 */
test('collapsed categories never bring up "No matching mods" over their own rows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const start = src.indexOf('function renderMods()');
  assert.ok(start > 0, 'renderMods is in app.js');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const collapse = body.indexOf('g.collapsed ? [] : g.mods');
  assert.ok(collapse > 0, 'collapsed categories leave the shown list');
  // What matched is counted before that line, and the panel and the card's empty look use only it.
  const counted = body.match(/const (\w+) = mods\.length;/);
  assert.ok(counted && body.indexOf(counted[0]) < collapse, 'the matching mods are counted before collapsed categories are left out');
  const empty = body.match(/\$\('#mods-empty'\)\.hidden = ([^;]+);/);
  const card = body.match(/classList\.toggle\('is-empty', ([^)]+)\)/);
  assert.ok(empty && card, 'the empty panel and the card are set in renderMods');
  for (const expr of [empty[1], card[1]]) {
    assert.ok(expr.includes(counted[1]) && !/\bmods\.length\b/.test(expr), `"${expr}" follows the matching mods, not the rows shown`);
  }
});
