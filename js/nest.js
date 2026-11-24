/*
 * Multi-sheet rectangle nesting (MaxRects), with grain-direction locking.
 * Items: { id, w, h, grainRot: 0|90, ... }. Sheet grain runs along sheet X,
 * so an item placed at rot = grainRot has its grain aligned with the sheet.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.Nest = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const EPS = 1e-6;

  class Bin {
    constructor(w, h) { this.w = w; this.h = h; this.free = [{ x: 0, y: 0, w, h }]; this.used = []; }

    find(w, h, heur) {
      let best = null;
      for (const f of this.free) {
        if (w > f.w + EPS || h > f.h + EPS) continue;
        const lw = f.w - w, lh = f.h - h;
        let s1, s2;
        switch (heur) {
          case 'BAF': s1 = f.w * f.h - w * h; s2 = Math.min(lw, lh); break;
          case 'BL': s1 = f.y + h; s2 = f.x; break;
          case 'BLSF': s1 = Math.max(lw, lh); s2 = Math.min(lw, lh); break;
          default: s1 = Math.min(lw, lh); s2 = Math.max(lw, lh); // BSSF
        }
        if (!best || s1 < best.s1 - EPS || (Math.abs(s1 - best.s1) <= EPS && s2 < best.s2)) {
          best = { x: f.x, y: f.y, w, h, s1, s2 };
        }
      }
      return best;
    }

    place(r) {
      const next = [];
      for (const f of this.free) {
        if (r.x >= f.x + f.w - EPS || r.x + r.w <= f.x + EPS || r.y >= f.y + f.h - EPS || r.y + r.h <= f.y + EPS) {
          next.push(f); continue;
        }
        if (r.x > f.x + EPS) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
        if (r.x + r.w < f.x + f.w - EPS) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
        if (r.y > f.y + EPS) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
        if (r.y + r.h < f.y + f.h - EPS) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
      }
      // prune rectangles contained in another
      this.free = next.filter((a, i) => !next.some((b, j) => j !== i &&
        a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS &&
        (j < i || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y)));
      this.used.push(r);
    }
  }

  const ORDERS = {
    area: (a, b) => b.w * b.h - a.w * a.h,
    long: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),
    height: (a, b) => b.h - a.h || b.w - a.w,
    width: (a, b) => b.w - a.w || b.h - a.h,
  };
  const HEURS = ['BSSF', 'BAF', 'BL', 'BLSF'];

  function orientations(it, allowRotate) {
    const rots = allowRotate ? [0, 90] : [it.grainRot || 0];
    return rots.map(rot => (rot === 90 ? { rot, w: it.h, h: it.w } : { rot, w: it.w, h: it.h }));
  }

  function better(a, b) { return !b || a.s1 < b.s1 - EPS || (Math.abs(a.s1 - b.s1) <= EPS && a.s2 < b.s2); }

  // sorted: pre-ordered items. global: pick the best position across all open
  // sheets (best fit) instead of the first sheet that has room (first fit).
  function runOnce(sorted, binW, binH, sp, allowRotate, heur, global) {
    const bins = [], unplaced = [];
    for (const it of sorted) {
      const opts = orientations(it, allowRotate);
      let done = false, pick = null;
      for (const bin of bins) {
        for (const o of opts) {
          const pos = bin.find(o.w + sp, o.h + sp, heur);
          if (pos && (!pick || better(pos, pick.pos))) pick = { bin, pos, o };
        }
        if (pick && !global) break;
      }
      if (pick) {
        pick.bin.place(Object.assign({ item: it, rot: pick.o.rot, pw: pick.o.w, ph: pick.o.h }, pick.pos));
        done = true;
      }
      if (done) continue;
      const bin = new Bin(binW, binH);
      let best = null;
      for (const o of opts) {
        const pos = bin.find(o.w + sp, o.h + sp, heur);
        if (pos && (!best || pos.s1 < best.pos.s1)) best = { pos, o };
      }
      if (!best) { unplaced.push(it); continue; }
      bin.place(Object.assign({ item: it, rot: best.o.rot, pw: best.o.w, ph: best.o.h }, best.pos));
      bins.push(bin);
    }
    return { bins, unplaced };
  }

  /**
   * Pack items onto as few sheets as possible.
   * opts: { margin, spacing, allowRotate }
   * Returns { sheets: [{ w, h, items: [{ item, x, y, rot, w, h }] }], unplaced }.
   */
  function pack(items, sheetW, sheetH, opts) {
    const margin = opts.margin || 0, sp = opts.spacing || 0;
    const binW = sheetW - 2 * margin + sp, binH = sheetH - 2 * margin + sp;
    const allowRotate = !!opts.allowRotate;
    let best = null;
    const tryRun = (sorted, heur, global) => {
      const r = runOnce(sorted, binW, binH, sp, allowRotate, heur, global);
      const last = r.bins.length ? r.bins[r.bins.length - 1].used.reduce((s, u) => s + u.w * u.h, 0) : 0;
      const score = [r.unplaced.length, r.bins.length, last];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] &&
        (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { r, score };
      }
    };
    // No packing can beat the total-area bound, so stop searching once we hit it.
    const area = items.reduce((s, it) => s + (it.w + sp) * (it.h + sp), 0);
    const lowerBound = Math.max(1, Math.ceil(area / (binW * binH) - 1e-9));
    const done = () => best && best.score[0] === 0 && best.score[1] <= lowerBound;

    // 1) Classic sorted orders with every heuristic.
    for (const k of Object.keys(ORDERS)) {
      const sorted = items.slice().sort(ORDERS[k]);
      for (const h of HEURS) { tryRun(sorted, h, false); tryRun(sorted, h, true); }
    }
    // 2) Seeded random orderings (deterministic: the same input always nests
    //    the same way). Budget scales down with part count to stay interactive.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const n = Math.max(items.length, 1);
    const trials = Math.max(4, Math.min(300, Math.round(400000 / (n * n))));
    for (let t = 0; t < trials && !done(); t++) {
      let sorted;
      if (t % 3 === 2) {
        sorted = items.slice();
        for (let i = sorted.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sorted[i], sorted[j]] = [sorted[j], sorted[i]]; }
      } else {
        const jitter = 0.2 + 1.2 * rand();
        sorted = items.map(it => ({ it, k: it.w * it.h * (1 + jitter * (rand() - 0.5)) })).sort((a, b) => b.k - a.k).map(x => x.it);
      }
      tryRun(sorted, 'BSSF', true);
      tryRun(sorted, 'BSSF', false);
      tryRun(sorted, 'BAF', true);
    }
    const sheets = best.r.bins.map(bin => ({
      w: sheetW, h: sheetH,
      items: bin.used.map(u => ({ item: u.item, x: margin + u.x, y: margin + u.y, rot: u.rot, w: u.pw, h: u.ph })),
    }));
    return { sheets, unplaced: best.r.unplaced };
  }

  return { pack, Bin };
});
