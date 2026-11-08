'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { fitBox, GAP, FLOOR } = require('../src/shared/fitbox');

// A 1000 × 700 view; the menus are 300 wide and 400 tall unless said otherwise.
const view = { left: 0, top: 0, right: 1000, bottom: 700 };
const at = (left, top, width = 300, height = 400) => ({ left, top, width, height });

test('fitBox: a menu that fits stays where it is', () => {
  assert.deepStrictEqual(fitBox({ box: at(100, 50), view }), { dx: 0, dy: 0, maxHeight: null });
});

test('fitBox: off the right edge (the Mods ⋯ menu in a narrow window) moves left, 8px in', () => {
  const r = fitBox({ box: at(780, 50), view });
  assert.strictEqual(r.dx, 1000 - 8 - (780 + 300));
  assert.strictEqual(780 + 300 + r.dx, 992);
});

test('fitBox: off the left edge moves right; wider than the view, its start shows', () => {
  assert.strictEqual(fitBox({ box: at(-40, 50), view }).dx, 48);
  assert.strictEqual(fitBox({ box: at(100, 50, 1200), view }).dx, 8 - 100);
});

test('fitBox: the edges of the page that scrolls count, not only the window', () => {
  const page = { left: 200, top: 60, right: 900, bottom: 700 };
  assert.strictEqual(fitBox({ box: at(700, 100), view: page }).dx, 900 - 8 - 1000);
});

test('fitBox: no room below, more above its button: it opens above', () => {
  const anchor = { top: 600, bottom: 630 };
  const r = fitBox({ box: at(100, 634), view, anchor, scrolls: true });
  assert.strictEqual(r.maxHeight, null);
  assert.strictEqual(634 + r.dy + 400, 600 - GAP, 'its bottom sits just above the button');
});

test('fitBox: a scrolling menu with little room either side is never made shorter than the floor', () => {
  // A short view: 38px below the button, 108px above it. A first version flipped it above at 108px.
  const short = { left: 0, top: 0, right: 1000, bottom: 200 };
  const anchor = { top: 120, bottom: 150 };
  const r = fitBox({ box: at(100, 154), view: short, anchor, scrolls: true });
  assert.ok(r.maxHeight >= FLOOR, `max height ${r.maxHeight}`);
  assert.strictEqual(r.dy, 0, 'it stays below its button (the page scrolls to the rest)');
});

test('fitBox: with room only below, a scrolling menu is made shorter to fit', () => {
  const anchor = { top: 20, bottom: 50 };
  const r = fitBox({ box: at(100, 54), view: { ...view, bottom: 300 }, anchor, scrolls: true });
  assert.strictEqual(r.maxHeight, 300 - 8 - 54);
  assert.strictEqual(r.dy, 0);
});

test('fitBox: a box that does not scroll (Saves "Copy to") moves up to fit, its top kept in view', () => {
  assert.strictEqual(fitBox({ box: at(100, 400), view }).dy, 700 - 8 - 800);
  assert.strictEqual(fitBox({ box: at(100, 100, 300, 900), view }).dy, 8 - 100);
  assert.strictEqual(fitBox({ box: at(100, -30, 300, 200), view }).dy, 38, 'above the top: moved down');
});
