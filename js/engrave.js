/*
 * Floor engraving: text labels laid out per compartment, as vector outlines.
 *
 * Path commands: { t: 'M'|'L'|'Q'|'C'|'Z', p: [[x, y], ...] } in millimetres,
 * y-up, in the floor's part frame. Q carries [ctrl, end], C [c1, c2, end].
 *
 * The floor part frame is the tray seen from ABOVE (u = tray x, v = D - tray y),
 * so text that reads correctly in the exported file reads correctly when the
 * floor is installed engraved-face-up, and divider slots still line up.
 *
 * Text shaping is injected ("shaper") so this module has no font dependency:
 *   shaper(text, capHeightMm) -> { cmds, x0, x1 }   (baseline y = 0, y-up)
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.Engrave = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Build a shaper from an opentype.js Font. */
  function makeShaper(font) {
    const os2 = font.tables && font.tables.os2;
    const capRatio = (os2 && os2.sCapHeight ? os2.sCapHeight : font.unitsPerEm * 0.7) / font.unitsPerEm;
    return (text, capH) => {
      const size = capH / capRatio;
      const path = font.getPath(text, 0, 0, size);
      const cmds = [];
      for (const c of path.commands) {
        // opentype.js paths are y-down; flip to y-up
        if (c.type === 'M' || c.type === 'L') cmds.push({ t: c.type, p: [[c.x, -c.y]] });
        else if (c.type === 'Q') cmds.push({ t: 'Q', p: [[c.x1, -c.y1], [c.x, -c.y]] });
        else if (c.type === 'C') cmds.push({ t: 'C', p: [[c.x1, -c.y1], [c.x2, -c.y2], [c.x, -c.y]] });
        else if (c.type === 'Z') cmds.push({ t: 'Z', p: [] });
      }
      const bb = path.getBoundingBox();
      const empty = !isFinite(bb.x1) || bb.x2 <= bb.x1;
      return { cmds, x0: empty ? 0 : bb.x1, x1: empty ? 0 : bb.x2 };
    };
  }

  function mapCmds(cmds, fn) { return cmds.map(c => ({ t: c.t, p: c.p.map(fn) })); }

  /**
   * Compartment rectangles in the floor frame.
   * divs = { x: [centres along W], y: [centres along D] } (tray coordinates).
   * Cell key "i,j": i counts left→right, j counts back→front (top→bottom of
   * the layout drawing).
   */
  function floorCells(W, D, T, divs) {
    const spans = (cs, L) => {
      const out = [];
      let prev = T;
      for (const c of cs.slice().sort((a, b) => a - b)) { out.push([prev, c - T / 2]); prev = c + T / 2; }
      out.push([prev, L - T]);
      return out;
    };
    const xs = spans((divs && divs.x) || [], W), ys = spans((divs && divs.y) || [], D);
    const cells = [];
    xs.forEach(([x0, x1], i) => ys.forEach(([y0, y1], j) => {
      cells.push({ key: `${i},${j}`, i, j, u0: x0, u1: x1, v0: D - y1, v1: D - y0 });
    }));
    return { cells, nx: xs.length, ny: ys.length };
  }

  /**
   * Lay out one label (may contain newlines) centred in a cell, rotated
   * counter-clockwise by rot (0, 90, 180 or 270 degrees; 90 reads bottom to top).
   * opts: { capH, pad, minCapH }. Returns { cmds, capH, shrunk, tooSmall }.
   */
  function layoutLabel(text, cell, opts, shaper, rot) {
    const r = (((Math.round((rot || 0) / 90) * 90) % 360) + 360) % 360;
    if (r) {
      // lay out in a cell of the rotated proportions at the origin, then turn it into place
      const hw = (cell.u1 - cell.u0) / 2, hh = (cell.v1 - cell.v0) / 2;
      const [vw, vh] = r % 180 ? [hh, hw] : [hw, hh];
      const res = layoutLabel(text, { u0: -vw, u1: vw, v0: -vh, v1: vh }, opts, shaper, 0);
      if (!res) return null;
      const cu = (cell.u0 + cell.u1) / 2, cv = (cell.v0 + cell.v1) / 2;
      const c = Math.round(Math.cos((r * Math.PI) / 180)), sn = Math.round(Math.sin((r * Math.PI) / 180));
      res.cmds = mapCmds(res.cmds, ([x, y]) => [cu + x * c - y * sn, cv + x * sn + y * c]);
      return res;
    }
    const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    const pad = opts.pad || 0;
    const availW = cell.u1 - cell.u0 - 2 * pad, availH = cell.v1 - cell.v0 - 2 * pad;
    const gap = 1.5; // line pitch as a multiple of cap height
    const measure = capH => lines.map(l => shaper(l, capH));
    let capH = opts.capH;
    let shaped = measure(capH);
    const widest = Math.max(...shaped.map(s => s.x1 - s.x0), 1e-6);
    const blockH = capH * (1 + gap * (lines.length - 1));
    const scale = Math.min(1, availW / widest, availH / blockH);
    if (scale < 1) { capH *= Math.max(scale, 0.01); shaped = measure(capH); }
    const cu = (cell.u0 + cell.u1) / 2, cv = (cell.v0 + cell.v1) / 2;
    const total = capH * (1 + gap * (lines.length - 1));
    const out = [];
    shaped.forEach((s, k) => {
      const base = cv + total / 2 - capH - k * gap * capH;
      const dx = cu - (s.x0 + s.x1) / 2;
      for (const c of mapCmds(s.cmds, ([x, y]) => [x + dx, y + base])) out.push(c);
    });
    return { cmds: out, capH, shrunk: scale < 1, tooSmall: capH < (opts.minCapH || 0) };
  }

  /**
   * Engraving for a whole floor. labels: { "i,j": "text" }, rots: { "i,j": deg }.
   * Returns { cmds, notes, boxes } where boxes are the labels' extents in the
   * floor frame (used to keep floor seams away from text).
   */
  function floorEngraving(W, D, T, divs, labels, opts, shaper, rots) {
    const { cells } = floorCells(W, D, T, divs);
    const cmds = [], notes = [], boxes = [];
    for (const cell of cells) {
      const text = labels && labels[cell.key];
      if (!text || !String(text).trim()) continue;
      const r = layoutLabel(text, cell, opts, shaper, rots && rots[cell.key]);
      if (!r) continue;
      cmds.push(...r.cmds);
      const pts = [].concat(...flatten(r.cmds, 1));
      if (pts.length) boxes.push({
        u0: Math.min(...pts.map(p => p[0])), u1: Math.max(...pts.map(p => p[0])),
        v0: Math.min(...pts.map(p => p[1])), v1: Math.max(...pts.map(p => p[1])),
      });
      if (r.tooSmall) notes.push(`"${String(text).replace(/\n/g, ' ')}" had to shrink to ${r.capH.toFixed(1)} mm tall to fit its compartment.`);
    }
    return { cmds, notes, boxes };
  }

  /** Split commands into subpaths (each starts with M). */
  function subpaths(cmds) {
    const out = [];
    for (const c of cmds) { if (c.t === 'M' || !out.length) out.push([]); out[out.length - 1].push(c); }
    return out;
  }

  /** Flatten curves into closed polylines (one per subpath) for DXF/3D. */
  function flatten(cmds, step) {
    const seg = step || 0.25;
    const polys = [];
    let cur = null, last = null;
    const n = len => Math.max(2, Math.min(24, Math.ceil(len / seg)));
    const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (const c of cmds) {
      if (c.t === 'M') { if (cur && cur.length > 2) polys.push(cur); cur = [c.p[0]]; last = c.p[0]; }
      else if (c.t === 'L') { cur.push(c.p[0]); last = c.p[0]; }
      else if (c.t === 'Q') {
        const [q, e] = c.p, k = n(dist(last, q) + dist(q, e));
        for (let i = 1; i <= k; i++) {
          const t = i / k, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t;
          cur.push([a * last[0] + b * q[0] + d * e[0], a * last[1] + b * q[1] + d * e[1]]);
        }
        last = e;
      } else if (c.t === 'C') {
        const [c1, c2, e] = c.p, k = n(dist(last, c1) + dist(c1, c2) + dist(c2, e));
        for (let i = 1; i <= k; i++) {
          const t = i / k, mt = 1 - t;
          const a = mt * mt * mt, b = 3 * mt * mt * t, cc = 3 * mt * t * t, d = t * t * t;
          cur.push([a * last[0] + b * c1[0] + cc * c2[0] + d * e[0], a * last[1] + b * c1[1] + cc * c2[1] + d * e[1]]);
        }
        last = e;
      } else if (c.t === 'Z') {
        if (cur && cur.length > 2) {
          const f = cur[0], l = cur[cur.length - 1];
          if (Math.abs(f[0] - l[0]) < 1e-9 && Math.abs(f[1] - l[1]) < 1e-9) cur.pop();
          polys.push(cur);
        }
        cur = null;
      }
    }
    if (cur && cur.length > 2) polys.push(cur);
    return polys;
  }

  /** SVG path data; fy maps a y-up coordinate to SVG y. */
  function svgPathData(cmds, fy) {
    const f = v => String(+v.toFixed(4));
    const pt = ([x, y]) => f(x) + ' ' + f(fy(y));
    return cmds.map(c => c.t === 'Z' ? 'Z' : c.t + c.p.map(pt).join(' ')).join('');
  }

  return { makeShaper, mapCmds, floorCells, layoutLabel, floorEngraving, flatten, svgPathData, subpaths };
});
