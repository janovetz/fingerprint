/*
 * Box geometry for laser-cut open-top trays.
 *
 * Joinery:
 *   - Vertical corners: finger (box) joints. Front/back walls carry tabs on the
 *     even segments (top and bottom), left/right walls carry the odd segments.
 *   - Floor: a separate panel whose edge tabs pass through rectangular slots
 *     near the bottom of every wall and finish flush with the outside face.
 *
 * Conventions: all lengths in millimetres. Part outlines are 2D polygons in a
 * y-up frame, counter-clockwise; holes are counter-clockwise too. Each part
 * also carries placements (an orthonormal frame in box coordinates
 * bx = width, by = depth, bz = up) so the same data drives the 3D preview and
 * the interference tests.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.BoxGeom = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MM_PER_IN = 25.4;
  const TINY = 1e-9;

  /* ---------------------------------------------------------------- units */

  function parseLength(input, units) {
    let s = String(input == null ? '' : input).trim().toLowerCase();
    if (!s) return NaN;
    s = s.replace(/[″”"]/g, ' in').replace(/\binch(es)?\b/g, 'in');
    let unit = units;
    const um = s.match(/(mm|cm|in)\s*$/);
    if (um) { unit = um[1]; s = s.slice(0, um.index).trim(); }
    s = s.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ');
    let val;
    const fm = s.match(/^(?:(\d+(?:\.\d+)?)[\s-]+)?(\d+)\/(\d+)$/);
    if (fm) {
      const den = +fm[3];
      if (!den) return NaN;
      val = (fm[1] ? +fm[1] : 0) + (+fm[2]) / den;
    } else if (/^\d*\.?\d+$/.test(s)) {
      val = +s;
    } else {
      return NaN;
    }
    if (unit === 'in') return val * MM_PER_IN;
    if (unit === 'cm') return val * 10;
    return val;
  }

  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

  function formatLength(mm, units) {
    if (!isFinite(mm)) return '';
    if (units === 'mm') return String(+mm.toFixed(2));
    const inch = mm / MM_PER_IN;
    const den = 64;
    const n = Math.round(inch * den);
    if (Math.abs(inch - n / den) < 0.0006) {
      const whole = Math.floor(n / den);
      const rem = n - whole * den;
      if (rem === 0) return String(whole);
      const g = gcd(rem, den);
      const fr = `${rem / g}/${den / g}`;
      return whole ? `${whole} ${fr}` : fr;
    }
    return String(+inch.toFixed(inch < 0.1 ? 4 : 3));
  }

  /* ------------------------------------------------------------- polygons */

  function samePt(a, b) { return Math.abs(a[0] - b[0]) < TINY && Math.abs(a[1] - b[1]) < TINY; }

  /** Drop duplicate and collinear vertices (also removes zero-width spikes). */
  function cleanPoly(pts) {
    const out = [];
    for (const p of pts) if (!out.length || !samePt(out[out.length - 1], p)) out.push([p[0], p[1]]);
    while (out.length > 1 && samePt(out[0], out[out.length - 1])) out.pop();
    for (let guard = 0; out.length > 3 && guard < 100000; guard++) {
      let removed = false;
      for (let i = 0; i < out.length; i++) {
        const n = out.length, a = out[(i - 1 + n) % n], b = out[i], c = out[(i + 1) % n];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) < TINY) { out.splice(i, 1); removed = true; break; }
      }
      if (!removed) break;
    }
    return out;
  }

  function signedArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  function ccw(poly) { return signedArea(poly) >= 0 ? poly : poly.slice().reverse(); }

  function bbox(poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x0) x0 = x; if (y < y0) y0 = y;
      if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  function edgeNormal(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    return [dy / L, -dx / L]; // outward for a CCW polygon
  }

  /**
   * Offset a rectilinear (all right-angle) CCW polygon by d along its outward
   * normals: d > 0 grows it, d < 0 shrinks it. Used for kerf compensation.
   */
  function offsetOrtho(poly, d) {
    if (!d) return poly.map(p => [p[0], p[1]]);
    const n = poly.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
      const n1 = edgeNormal(a, b), n2 = edgeNormal(b, c);
      out.push([b[0] + d * (n1[0] + n2[0]), b[1] + d * (n1[1] + n2[1])]);
    }
    return out;
  }

  function pointInPoly(pt, poly) {
    let inside = false;
    const [x, y] = pt;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function polyArea(outline, holes) {
    return Math.abs(signedArea(outline)) - (holes || []).reduce((s, h) => s + Math.abs(signedArea(h)), 0);
  }

  /* --------------------------------------------------------------- joinery */

  /** Odd number of finger segments (>= 3) closest to the target width. */
  function segmentCount(len, target) {
    const ideal = len / Math.max(target, 0.1);
    let n = Math.round(ideal);
    if (n % 2 === 0) n = ideal >= n ? n + 1 : n - 1;
    return Math.max(3, n);
  }

  /** Evenly spaced floor-tab ranges along an inner edge of length len. */
  function tabRanges(len, tabW, pitch) {
    if (len <= 0) return [];
    const tw = Math.min(tabW, len * 0.5);
    let m = Math.max(1, Math.round(len / Math.max(pitch, 0.1)));
    while (m > 1 && len / m < tw * 1.5) m--;
    const out = [];
    for (let i = 0; i < m; i++) {
      const c = ((i + 0.5) * len) / m;
      out.push([c - tw / 2, c + tw / 2]);
    }
    return out;
  }

  /**
   * A wall of length L and height H with finger ends of depth T.
   * tabsAtEven: segment 0 (bottom) is a tab that reaches the end of the wall.
   */
  function wallOutline(L, H, T, n, tabsAtEven) {
    const h = H / n, pts = [];
    const isTab = i => (i % 2 === 0) === tabsAtEven;
    for (let i = 0; i < n; i++) {
      const x = isTab(i) ? L : L - T;
      pts.push([x, i * h], [x, (i + 1) * h]);
    }
    for (let i = n - 1; i >= 0; i--) {
      const x = isTab(i) ? 0 : T;
      pts.push([x, (i + 1) * h], [x, i * h]);
    }
    return ccw(cleanPoly(pts));
  }

  function rectPoly(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }

  /** Floor panel in box coordinates: bbox [0,W] x [0,D]. */
  function floorOutline(W, D, T, tabsX, tabsY) {
    const pts = [[T, T]];
    for (const [a, b] of tabsX) pts.push([a, T], [a, 0], [b, 0], [b, T]);
    pts.push([W - T, T]);
    for (const [a, b] of tabsY) pts.push([W - T, a], [W, a], [W, b], [W - T, b]);
    pts.push([W - T, D - T]);
    for (const [a, b] of tabsX.slice().reverse()) pts.push([b, D - T], [b, D], [a, D], [a, D - T]);
    pts.push([T, D - T]);
    for (const [a, b] of tabsY.slice().reverse()) pts.push([T, b], [0, b], [0, a], [T, a]);
    return ccw(cleanPoly(pts));
  }

  /**
   * Divider (internal wall) of length len in its own (u, v) frame, where v is
   * absolute height in the tray. The body spans u in [T, len-T] between the
   * inner wall faces, v in [zb, top]. End tabs pass through wall slots to
   * u = 0 / len; bottom tabs drop through floor slots to v = lift.
   * Half-lap notches: bottomNotches rise from zb to mid, topNotches fall from
   * top to mid.
   */
  function dividerOutline(len, T, lift, zb, top, mid, endTabs, bottomTabs, bottomNotches, topNotches) {
    const pts = [[T, zb]];
    const ev = bottomTabs.map(r => ({ r, y: lift })).concat(bottomNotches.map(r => ({ r, y: mid })))
      .sort((a, b) => a.r[0] - b.r[0]);
    for (const { r: [a, b], y } of ev) pts.push([a, zb], [a, y], [b, y], [b, zb]);
    pts.push([len - T, zb]);
    for (const [a, b] of endTabs) pts.push([len - T, a], [len, a], [len, b], [len - T, b]);
    pts.push([len - T, top]);
    for (const [a, b] of topNotches.slice().sort((p, q) => q[0] - p[0])) pts.push([b, top], [b, mid], [a, mid], [a, top]);
    pts.push([T, top]);
    for (const [a, b] of endTabs.slice().reverse()) pts.push([T, b], [0, b], [0, a], [T, a]);
    return ccw(cleanPoly(pts));
  }

  /**
   * Floor tabs for a divider spanning [s0, s1]: tabs sit in the segments
   * between crossing dividers (each crossing occupies c ± T/2), padded away
   * from walls and crossings.
   */
  function segmentTabs(s0, s1, crossings, T, tabW, pitch) {
    const cuts = crossings.slice().sort((a, b) => a - b);
    const bounds = [s0];
    for (const c of cuts) bounds.push(c - T / 2, c + T / 2);
    bounds.push(s1);
    const out = [];
    for (let i = 0; i < bounds.length; i += 2) {
      const a = bounds[i], b = bounds[i + 1], L = b - a;
      const pad = Math.min(T, L * 0.15);
      if (L - 2 * pad < 4) continue;
      for (const [x, y] of tabRanges(L - 2 * pad, tabW, pitch)) if (y - x >= 3) out.push([a + pad + x, a + pad + y]);
    }
    return out;
  }

  /** Smallest compartment the dividers may leave (mm). */
  function minCompartment(T) { return Math.max(10, T * 1.5); }

  /** Even divider centres for n dividers across an outer size L (walls of T). */
  function evenDividers(L, T, n) {
    const inner = L - 2 * T, c = (inner - n * T) / (n + 1), out = [];
    for (let k = 0; k < n; k++) out.push(T + c * (k + 1) + T * k + T / 2);
    return out;
  }

  /** Most dividers that fit across an outer size L. */
  function maxDividers(L, T) {
    const m = minCompartment(T);
    return Math.max(0, Math.floor((L - 2 * T - m) / (T + m)));
  }

  /** True when every compartment between walls/dividers is wide enough. */
  function dividersValid(L, T, centres) {
    const m = minCompartment(T) - 1e-6;
    let prev = T;
    for (const c of centres.slice().sort((a, b) => a - b)) {
      if (c - T / 2 - prev < m) return false;
      prev = c + T / 2;
    }
    return L - T - prev >= m;
  }

  /* -------------------------------------------------------- split floors */

  /**
   * Puzzle-key size for joining floor pieces. Rectilinear "T" key: a neck
   * (width nw, length l1) and a wider head (width hw) that locks the pieces
   * together in-plane. L is how far a key reaches past the seam.
   */
  function keyDims(T) {
    const u = Math.max(T, 4);
    return { nw: 1.2 * u, hw: 2.4 * u, l1: 0.9 * u, L: 2.0 * u, m: Math.max(T * 0.5, 2) };
  }

  const inAny = (x, ivs) => ivs.some(([a, b]) => x > a && x < b);

  /** Closest allowed value to `ideal` inside [lo, hi], outside every forbidden interval. */
  function nearestAllowed(ideal, lo, hi, forbid, prefer) {
    if (lo > hi) return null;
    // preferred points (seams hidden under dividers) win whenever they fit
    let best = null;
    for (const c of prefer || []) {
      if (c < lo - 1e-9 || c > hi + 1e-9 || inAny(c, forbid)) continue;
      if (best === null || Math.abs(c - ideal) < Math.abs(best - ideal)) best = c;
    }
    if (best !== null) return best;
    const cands = [Math.max(lo, Math.min(hi, ideal)), lo, hi];
    for (const [a, b] of forbid) cands.push(a - 1e-3, b + 1e-3);
    for (const c of cands) {
      if (c < lo - 1e-9 || c > hi + 1e-9 || inAny(c, forbid)) continue;
      if (best === null || Math.abs(c - ideal) < Math.abs(best - ideal)) best = c;
    }
    return best;
  }

  /**
   * Seam positions along one floor axis. The body spans [T, L-T]; the edge
   * tabs reach T further, and each seam may add a key reach K to the pieces on
   * both sides. Returns [] (no split), an array of seams, or null (impossible).
   */
  function planAxis(L, T, K, maxExt, forbid, prefer) {
    const b0 = T, b1 = L - T;
    if (L <= maxExt) return [];
    const minPiece = 3 * K;
    for (let k = 2; k <= 12; k++) {
      const seams = [];
      let prev = b0, ok = true;
      for (let i = 0; i < k - 1; i++) {
        const leftExt = i === 0 ? T : K;
        const r = k - i - 1; // pieces after this seam
        const hi = prev - leftExt + maxExt - K;
        const lo = Math.max(prev + minPiece, b1 + T - (maxExt - K) - (r - 1) * (maxExt - 2 * K));
        const ideal = prev + (b1 - prev) / (r + 1);
        const sAt = nearestAllowed(ideal, lo, Math.min(hi, b1 - minPiece), forbid, prefer);
        if (sAt === null) { ok = false; break; }
        seams.push(sAt); prev = sAt;
      }
      if (ok && b1 + T - (prev - K) <= maxExt + 1e-9) return seams;
    }
    return null;
  }

  /** Evenly spread key centres in [lo, hi], avoiding forbidden bands. */
  function placeKeys(lo, hi, pitch, minGap, forbid) {
    if (hi <= lo) return [];
    const n = Math.max(1, Math.round((hi - lo) / pitch));
    const out = [];
    for (let i = 0; i < n; i++) {
      const ideal = lo + ((i + 0.5) * (hi - lo)) / n;
      const c = nearestAllowed(ideal, lo, hi, forbid);
      if (c !== null && out.every(o => Math.abs(o - c) >= minGap)) out.push(c);
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * Points along a seam at `at`, in increasing order along the seam.
   * axis 'x' = vertical seam (x = at, running along y); 'y' = horizontal.
   * seg.keys [{ c, d }]: puzzle keys shared by both pieces (d = +1 bulges
   * toward +x / +y). seg.slots [[a, b]]: the seam runs under a divider, whose
   * floor slots are split between the pieces; side (-1 low piece, +1 high
   * piece) says which half of each slot this piece is notched for.
   */
  function seamPts(axis, at, seg, kd, T, side) {
    const pts = [];
    const P = (along, off) => (axis === 'x' ? [at + off, along] : [along, at + off]);
    if (seg.slots) {
      for (const [a, b] of seg.slots) pts.push(P(a, 0), P(a, side * T / 2), P(b, side * T / 2), P(b, 0));
      return pts;
    }
    for (const { c, d } of seg.keys) {
      pts.push(P(c - kd.nw / 2, 0), P(c - kd.nw / 2, d * kd.l1), P(c - kd.hw / 2, d * kd.l1), P(c - kd.hw / 2, d * kd.L),
        P(c + kd.hw / 2, d * kd.L), P(c + kd.hw / 2, d * kd.l1), P(c + kd.nw / 2, d * kd.l1), P(c + kd.nw / 2, 0));
    }
    return pts;
  }

  /** Edge tabs clipped to [lo, hi] (a seam may split a tab between two pieces). */
  const clipTabs = (tabs, lo, hi) => tabs.filter(([a, b]) => b > lo + 1e-9 && a < hi - 1e-9).map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]);

  /**
   * Split the floor (box coordinates) into a grid of pieces so each piece
   * fits within maxX × maxY. Seams prefer to run under dividers (hidden, and
   * the divider's tabs tie the pieces); elsewhere they get puzzle keys.
   * Returns null when no split is needed, { impossible } when it can't fit.
   */
  function splitFloor(W, D, T, tabsX, tabsY, slots, ctx) {
    const kd = keyDims(T), K = kd.L, m = kd.m;
    const { maxX, maxY, divX, divY, xBottom, yBottom, keepOut } = ctx;
    const fx = [], fy = [];
    // a seam may cut through an edge tab, but not leave a sliver of one
    for (const [a, b] of tabsX) fx.push([a - m, a + m], [b - m, b + m]);
    for (const [a, b] of tabsY) fy.push([a - m, a + m], [b - m, b + m]);
    // keyed seams stay clear of dividers; a seam exactly under one is allowed
    for (const c of divX) fx.push([c - T / 2 - K - m, c - 1e-3], [c + 1e-3, c + T / 2 + K + m]);
    for (const c of divY) fy.push([c - T / 2 - K - m, c - 1e-3], [c + 1e-3, c + T / 2 + K + m]);
    if (divY.length) for (const [a, b] of yBottom) fx.push([a - m, b + m]);
    if (divX.length) for (const [a, b] of xBottom) fy.push([a - m, b + m]);
    for (const r of keepOut || []) { fx.push([r.x0 - K - m, r.x1 + K + m]); fy.push([r.y0 - K - m, r.y1 + K + m]); }
    const sx = planAxis(W, T, K, maxX, fx, divX), sy = planAxis(D, T, K, maxY, fy, divY);
    if (sx === null || sy === null) return { impossible: true };
    if (!sx.length && !sy.length) return null;
    const xs = [T, ...sx, W - T], ys = [T, ...sy, D - T];
    const onDiv = (v, cs) => cs.some(c => Math.abs(c - v) < 1e-6);

    // keys: keep clear of crossings and ends, divider slot rows and labels
    const pitch = Math.max(55, 6 * kd.hw), gap = kd.hw + 2 * m;
    const bandV = divY.map(c => [c - T / 2 - kd.hw / 2 - m, c + T / 2 + kd.hw / 2 + m]);
    const bandH = divX.map(c => [c - T / 2 - kd.hw / 2 - m, c + T / 2 + kd.hw / 2 + m]);
    const endPad = kd.hw / 2 + K + m;
    let flip = 1;
    const segsFor = (at, isDiv, slotRanges, cuts, band) => cuts.slice(0, -1).map((c0, j) => isDiv
      ? { slots: slotRanges.filter(([a, b]) => a > c0 && b < cuts[j + 1]) }
      : { keys: placeKeys(c0 + endPad, cuts[j + 1] - endPad, pitch, gap, band).map(c => ({ c, d: (flip = -flip) })) });
    const segV = sx.map(at => segsFor(at, onDiv(at, divX), xBottom, ys, bandV));
    const segH = sy.map(at => segsFor(at, onDiv(at, divY), yBottom, xs, bandH));

    const pieces = [];
    const n = (xs.length - 1) * (ys.length - 1);
    for (let j = 0; j < ys.length - 1; j++) {
      for (let i = 0; i < xs.length - 1; i++) {
        const x0 = xs[i], x1 = xs[i + 1], y0 = ys[j], y1 = ys[j + 1];
        const pts = [[x0, y0]];
        if (j === 0) { for (const [a, b] of clipTabs(tabsX, x0, x1)) pts.push([a, T], [a, 0], [b, 0], [b, T]); }
        else pts.push(...seamPts('y', y0, segH[j - 1][i], kd, T, +1));
        pts.push([x1, y0]);
        if (i === xs.length - 2) { for (const [a, b] of clipTabs(tabsY, y0, y1)) pts.push([W - T, a], [W, a], [W, b], [W - T, b]); }
        else pts.push(...seamPts('x', x1, segV[i][j], kd, T, -1));
        pts.push([x1, y1]);
        if (j === ys.length - 2) { for (const [a, b] of clipTabs(tabsX, x0, x1).reverse()) pts.push([b, D - T], [b, D], [a, D], [a, D - T]); }
        else pts.push(...seamPts('y', y1, segH[j][i], kd, T, -1).reverse());
        pts.push([x0, y1]);
        if (i === 0) { for (const [a, b] of clipTabs(tabsY, y0, y1).reverse()) pts.push([T, b], [0, b], [0, a], [T, a]); }
        else pts.push(...seamPts('x', x0, segV[i - 1][j], kd, T, +1).reverse());
        const holes = slots.filter(h => {
          const bb = bbox(h), cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
          if (onDiv(cx, sx) || onDiv(cy, sy)) return false; // split into notches instead
          return cx > x0 && cx < x1 && cy > y0 && cy < y1;
        });
        pieces.push({ i, j, index: pieces.length + 1, of: n, outline: ccw(cleanPoly(pts)), holes, cell: { x0, x1, y0, y1 } });
      }
    }
    // seam polylines for drawings (box coordinates)
    const seams = [];
    sx.forEach((at, a) => { const pl = [[at, T]]; ys.slice(0, -1).forEach((y0, j) => { if (segV[a][j].keys) pl.push(...seamPts('x', at, segV[a][j], kd, T, 0)); pl.push([at, ys[j + 1]]); }); seams.push(pl); });
    sy.forEach((at, b) => { const pl = [[T, at]]; xs.slice(0, -1).forEach((x0, i) => { if (segH[b][i].keys) pl.push(...seamPts('y', at, segH[b][i], kd, T, 0)); pl.push([xs[i + 1], at]); }); seams.push(pl); });
    const hidden = sx.filter(v => onDiv(v, divX)).length + sy.filter(v => onDiv(v, divY)).length;
    return { pieces, seams, nx: xs.length - 1, ny: ys.length - 1, hiddenSeams: hidden, keyedSeams: sx.length + sy.length - hidden };
  }

  const DEFAULTS = {
    T: 6.35,          // material thickness
    finger: 9.525,    // target finger width (3/8")
    lift: 3.175,      // floor raised above the wall bottoms (1/8")
    tabW: 12.7,       // floor tab width (1/2")
    tabPitch: 25.4,   // floor tab spacing (1")
    divDrop: 0,       // dividers stop this far below the tray top
    kerf: 0,          // laser beam width; 0 = service compensates
  };

  /**
   * Build all parts of one tray of outer size W x D x H.
   * dims.dividers = { x: [centres along W], y: [centres along D] } (mm, box coords)
   * Returns { parts, segments, segH, lift, divTop, warnings, ... }.
   */
  function buildBox(dims, params) {
    const p = Object.assign({}, DEFAULTS, params || {});
    const { W, D, H } = dims;
    const T = p.T;
    const warnings = [];
    const minSide = 2 * T + Math.max(6, p.tabW * 0.5);
    if (W < minSide || D < minSide) warnings.push(`Footprint ${W.toFixed(1)}×${D.toFixed(1)} mm is too small for ${T} mm stock.`);
    let lift = Math.max(0.8, p.lift);
    if (lift + T > H - T) { lift = Math.max(0.8, H - 2 * T); warnings.push('Floor lift reduced to fit the wall height.'); }
    if (p.lift < 0.8) warnings.push('Floor lift raised to 0.8 mm so the slots keep a bridge under them.');

    const n = segmentCount(H, p.finger);
    const segH = H / n;
    if (segH < T * 0.75) warnings.push(`Fingers are only ${segH.toFixed(1)} mm tall; consider a wider finger setting.`);

    const tabsX = tabRanges(W - 2 * T, p.tabW, p.tabPitch).map(([a, b]) => [a + T, b + T]);
    const tabsY = tabRanges(D - 2 * T, p.tabW, p.tabPitch).map(([a, b]) => [a + T, b + T]);
    const slot = ([a, b]) => rectPoly(a, lift, b, lift + T);

    // ---- dividers
    const dv = dims.dividers || {};
    const divX = (dv.x || []).slice().sort((a, b) => a - b);
    const divY = (dv.y || []).slice().sort((a, b) => a - b);
    const hasDiv = divX.length + divY.length > 0;
    const zb = lift + T;
    let top = H - Math.max(0, p.divDrop || 0);
    if (hasDiv && top - zb < 2 * T) { top = Math.min(H, zb + 2 * T); warnings.push('Dividers raised to stay at least twice the stock thickness tall.'); }
    if (hasDiv && (!dividersValid(W, T, divX) || !dividersValid(D, T, divY))) warnings.push('Dividers are too close to each other or to a wall.');
    const mid = (zb + top) / 2;
    const endTabs = hasDiv ? tabRanges(top - zb, p.tabW, p.tabPitch).map(([a, b]) => [a + zb, b + zb]) : [];
    const xBottom = segmentTabs(T, D - T, divY, T, p.tabW, p.tabPitch); // X-dividers run along y
    const yBottom = segmentTabs(T, W - T, divX, T, p.tabW, p.tabPitch); // Y-dividers run along x
    const wallSlots = cs => [].concat(...cs.map(c => endTabs.map(([a, b]) => rectPoly(c - T / 2, a, c + T / 2, b))));
    const floorSlots = [].concat(
      ...divX.map(c => xBottom.map(([a, b]) => rectPoly(c - T / 2, a, c + T / 2, b))),
      ...divY.map(c => yBottom.map(([a, b]) => rectPoly(a, c - T / 2, b, c + T / 2))));

    const fb = {
      role: 'fb', name: 'Front/Back',
      outline: wallOutline(W, H, T, n, true),
      holes: tabsX.map(slot).concat(wallSlots(divX)),
      w: W, h: H, grain: 'x',
      placements: [
        { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], explode: [0, -1, 0] },
        { o: [0, D - T, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], explode: [0, 1, 0] },
      ],
    };
    const lr = {
      role: 'lr', name: 'Left/Right',
      outline: wallOutline(D, H, T, n, false),
      holes: tabsY.map(slot).concat(wallSlots(divY)),
      w: D, h: H, grain: 'x',
      placements: [
        { o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0], explode: [-1, 0, 0] },
        { o: [W - T, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0], explode: [1, 0, 0] },
      ],
    };
    // The floor is drawn as seen from above (v = D - y), so an engraved floor
    // reads correctly in the cut file and its slots match when installed
    // engraved-face-up. (Box coordinates are mirrored relative to the physical
    // top view, hence the flip.)
    const flipV = poly => ccw(cleanPoly(poly.map(([x, y]) => [x, D - y])));
    const floorGrain = W >= D - 0.01 ? 'x' : 'y'; // tolerance: square floors stay unrotated
    const floorPlacement = ex => ({ o: [0, D, lift], u: [1, 0, 0], v: [0, -1, 0], n: [0, 0, 1], explode: ex || [0, 0, -1] });

    // Floors bigger than the stock are split into keyed pieces. dims.floorMax
    // lists the allowed piece extents [{ x, y }] (box axes); the plan with the
    // fewest pieces wins.
    let split = null;
    for (const fm of dims.floorMax || []) {
      const r = splitFloor(W, D, T, tabsX, tabsY, floorSlots,
        { maxX: fm.x, maxY: fm.y, divX, divY, xBottom, yBottom, keepOut: dims.keepOut });
      if (r === null) { split = null; break; } // fits whole in this orientation
      if (r.impossible) { if (!split) split = r; continue; }
      if (!split || split.impossible || r.pieces.length < split.pieces.length) split = r;
    }
    let floors;
    if (split && !split.impossible) {
      floors = split.pieces.map(pc => {
        const cx = (pc.cell.x0 + pc.cell.x1) / 2, cy = (pc.cell.y0 + pc.cell.y1) / 2;
        const sx = split.nx > 1 ? Math.sign(cx - W / 2) * 0.6 : 0, sy = split.ny > 1 ? Math.sign(cy - D / 2) * 0.6 : 0;
        return {
          role: 'floor', name: `Floor ${pc.index}/${pc.of}`, piece: { index: pc.index, of: pc.of },
          outline: flipV(pc.outline), holes: pc.holes.map(flipV),
          cell: { u0: pc.cell.x0, u1: pc.cell.x1, v0: D - pc.cell.y1, v1: D - pc.cell.y0 },
          w: W, h: D, grain: floorGrain, placements: [floorPlacement([sx, sy, -1])],
        };
      });
    } else {
      if (split && split.impossible) warnings.push("The floor can't be split into pieces that fit the stock. Use larger stock.");
      floors = [{
        role: 'floor', name: 'Floor',
        outline: flipV(floorOutline(W, D, T, tabsX, tabsY)),
        holes: floorSlots.map(flipV),
        w: W, h: D, grain: floorGrain, placements: [floorPlacement()],
      }];
    }
    const parts = [fb, lr, ...floors];
    const notch = cs => cs.map(c => [c - T / 2, c + T / 2]);
    if (divX.length) parts.push({
      role: 'dx', name: 'Divider (across width)',
      // X-dividers sit under the Y-dividers at crossings: notches from the top.
      outline: dividerOutline(D, T, lift, zb, top, mid, endTabs, xBottom, [], notch(divY)),
      holes: [], w: D, h: top - lift, grain: 'x',
      placements: divX.map(c => ({ o: [c - T / 2, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0], explode: [0, 0, 1.6] })),
    });
    if (divY.length) parts.push({
      role: 'dy', name: 'Divider (across depth)',
      outline: dividerOutline(W, T, lift, zb, top, mid, endTabs, yBottom, notch(divX), []),
      holes: [], w: W, h: top - lift, grain: 'x',
      placements: divY.map(c => ({ o: [0, c - T / 2, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], explode: [0, 0, 2.4] })),
    });
    return {
      parts, segments: n, segH, lift, divTop: top,
      floorPieces: floors.length, floorSeams: split && !split.impossible ? split.seams : [],
      floorHiddenSeams: split && !split.impossible ? split.hiddenSeams : 0,
      tabsPerSide: { x: tabsX.length, y: tabsY.length }, warnings,
    };
  }

  /**
   * Geometry the laser should follow: outlines grown and holes shrunk by
   * half the kerf, normalised so the bounding box starts at the origin.
   */
  function cutGeometry(part, kerf) {
    const k = (kerf || 0) / 2;
    const outline = offsetOrtho(part.outline, k);
    const holes = part.holes.map(h => offsetOrtho(ccw(h), -k));
    const bb = bbox(outline);
    const sh = poly => poly.map(([x, y]) => [x - bb.x0, y - bb.y0]);
    const engrave = part.engrave && part.engrave.length
      ? part.engrave.map(c => ({ t: c.t, p: sh(c.p) })) : null;
    return { outline: sh(outline), holes: holes.map(sh), engrave, w: bb.w, h: bb.h };
  }

  /** Point (box coordinates) inside a placed part? Used by tests. */
  function pointInPlacedPart(P, part, pl, T) {
    const d = [P[0] - pl.o[0], P[1] - pl.o[1], P[2] - pl.o[2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const w = dot(d, pl.n);
    if (w <= 0 || w >= T) return false;
    const uv = [dot(d, pl.u), dot(d, pl.v)];
    if (!pointInPoly(uv, part.outline)) return false;
    for (const h of part.holes) if (pointInPoly(uv, h)) return false;
    return true;
  }

  return {
    MM_PER_IN, DEFAULTS,
    parseLength, formatLength,
    cleanPoly, signedArea, ccw, bbox, offsetOrtho, pointInPoly, polyArea,
    segmentCount, tabRanges, wallOutline, floorOutline, dividerOutline,
    minCompartment, evenDividers, maxDividers, dividersValid, keyDims, planAxis,
    buildBox, cutGeometry, pointInPlacedPart,
  };
});
