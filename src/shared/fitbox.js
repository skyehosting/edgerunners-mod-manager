/*
 * Where a pop-up (a menu or small box placed next to its button) must move so it is wholly visible.
 * Plain numbers in, plain numbers out (no page), so it can be tested; the window's keepInView
 * measures the page and applies the answer.
 *
 *   box    { left, top, width, height }  where it is laid out now
 *   view   { left, top, right, bottom }  what can be seen (the window, or the page that scrolls)
 *   anchor { top, bottom } | null        its button: with no room below, it may open above it
 *   scrolls                              its content scrolls, so it may be made shorter
 * → { dx, dy, maxHeight } (maxHeight null: its own height)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FitBox = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const GAP = 4;    // between a menu and its button
  const FLOOR = 128; // a scrolling menu is never made shorter than this (about three items)

  function fitBox({ box, view, anchor = null, scrolls = false, pad = 8 }) {
    const { left, top, width: w, height: ht } = box;
    let dx = 0;
    if (left + w > view.right - pad) dx = view.right - pad - (left + w);
    if (left + dx < view.left + pad) dx = view.left + pad - left; // too wide for both: its start shows
    let dy = 0;
    let maxHeight = null;
    const low = view.bottom - pad;
    if (top + ht > low) {
      const roomBelow = low - top;
      const roomAbove = anchor ? anchor.top - GAP - (view.top + pad) : 0;
      const fitsAbove = roomAbove >= ht || (scrolls && roomAbove >= Math.min(ht, FLOOR));
      if (anchor && roomAbove > roomBelow && fitsAbove) {
        const fit = Math.min(ht, roomAbove);
        if (fit < ht) maxHeight = Math.floor(fit);
        dy = anchor.top - GAP - fit - top;
      } else if (scrolls) {
        const fit = Math.max(Math.floor(roomBelow), Math.min(ht, FLOOR));
        if (fit < ht) maxHeight = fit;
      } else {
        dy = low - (top + ht);
        if (top + dy < view.top + pad) dy = view.top + pad - top; // taller than the view: its top shows
      }
    } else if (top < view.top + pad) dy = view.top + pad - top;
    return { dx: Math.round(dx), dy: Math.round(dy), maxHeight };
  }

  return { fitBox, GAP, FLOOR };
}));
