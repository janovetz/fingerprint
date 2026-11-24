#!/usr/bin/env node
/* Run: node test/run.js */
'use strict';
const assert = require('assert');
const G = require('../js/geometry.js');
const L = require('../js/layout.js');
const N = require('../js/nest.js');
const X = require('../js/export.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n    ')); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('units');
test('parse inches, fractions, mm', () => {
  assert.ok(near(G.parseLength('1/4', 'in'), 6.35));
  assert.ok(near(G.parseLength('3 1/2', 'in'), 88.9));
  assert.ok(near(G.parseLength('3-1/2"', 'mm'), 88.9));
  assert.ok(near(G.parseLength('12.5', 'mm'), 12.5));
  assert.ok(near(G.parseLength('2 cm', 'in'), 20));
  assert.ok(near(G.parseLength('12/16', 'in'), 19.05));
  assert.ok(isNaN(G.parseLength('abc', 'in')));
});
test('format inches as fractions', () => {
  assert.strictEqual(G.formatLength(6.35, 'in'), '1/4');
  assert.strictEqual(G.formatLength(88.9, 'in'), '3 1/2');
  assert.strictEqual(G.formatLength(25.4 * 2, 'in'), '2');
  assert.strictEqual(G.formatLength(25.4 * 1.2371, 'in'), '1.237');
  assert.strictEqual(G.formatLength(12.3456, 'mm'), '12.35');
});

console.log('geometry');
test('finger segment count is odd and >= 3', () => {
  for (let H = 10; H < 200; H += 3.3) {
    const n = G.segmentCount(H, 9.5);
    assert.ok(n >= 3 && n % 2 === 1, `H=${H} n=${n}`);
  }
});
test('kerf offset grows outlines and shrinks holes', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const grown = G.offsetOrtho(sq, 0.1);
  assert.ok(near(Math.abs(G.signedArea(grown)), 10.2 * 10.2));
  const shrunk = G.offsetOrtho(sq, -0.1);
  assert.ok(near(Math.abs(G.signedArea(shrunk)), 9.8 * 9.8));
  const box = G.buildBox({ W: 100, D: 80, H: 60 }, { T: 6 });
  const wall = box.parts[0];
  const cut = G.cutGeometry(wall, 0.2);
  assert.ok(near(cut.w, 100.2) && near(cut.h, 60.2), `${cut.w} x ${cut.h}`);
  const slot = cut.holes[0], bb = G.bbox(slot);
  assert.ok(near(bb.h, 6 - 0.2), 'slot height shrinks by kerf');
});
test('outlines are clean rectilinear CCW polygons', () => {
  const box = G.buildBox({ W: 123, D: 77, H: 55 }, { T: 6.35 });
  for (const p of box.parts) {
    assert.ok(G.signedArea(p.outline) > 0, p.name + ' CCW');
    for (let i = 0; i < p.outline.length; i++) {
      const a = p.outline[i], b = p.outline[(i + 1) % p.outline.length];
      assert.ok(near(a[0], b[0]) || near(a[1], b[1]), p.name + ' axis-aligned edge');
    }
  }
});

/* Voxel-style assembly check: every sample point in the tray's shell and floor
   is covered by exactly one part, and nothing else is covered. */
function assemblyCheck(dims, params) {
  const p = Object.assign({}, G.DEFAULTS, params);
  const box = G.buildBox(dims, p);
  const { W, D, H } = dims, T = p.T, lift = box.lift, top = box.divTop;
  const dx = (dims.dividers && dims.dividers.x) || [], dy = (dims.dividers && dims.dividers.y) || [];
  const step = T / 3.37, off = step * 0.413;
  const placed = [];
  for (const part of box.parts) for (const pl of part.placements) placed.push({ part, pl });
  let pts = 0, overlaps = 0, gaps = 0, strays = 0;
  for (let x = -2 + off; x < W + 2; x += step) {
    for (let y = -2 + off; y < D + 2; y += step) {
      for (let z = -2 + off; z < H + 2; z += step) {
        let c = 0;
        for (const { part, pl } of placed) if (G.pointInPlacedPart([x, y, z], part, pl, T)) c++;
        const inBox = x > 0 && x < W && y > 0 && y < D && z > 0 && z < H;
        const inShell = inBox && (x < T || x > W - T || y < T || y > D - T);
        const inFloor = inBox && z > lift && z < lift + T;
        const inDiv = inBox && !inShell && z > lift + T && z < top &&
          (dx.some(c => Math.abs(x - c) < T / 2) || dy.some(c => Math.abs(y - c) < T / 2));
        const expect = inShell || inFloor || inDiv ? 1 : 0;
        pts++;
        if (c > 1) overlaps++;
        else if (c < expect) gaps++;
        else if (c > expect) strays++;
      }
    }
  }
  return { pts, overlaps, gaps, strays, box };
}

const cases = [
  [{ W: 100, D: 150, H: 63.5 }, { T: 6.35 }],
  [{ W: 88.9, D: 254, H: 50.8 }, { T: 6.35, finger: 12 }],
  [{ W: 60, D: 60, H: 30 }, { T: 3, finger: 6, tabW: 8, tabPitch: 15 }],
  [{ W: 300, D: 120, H: 80 }, { T: 6, lift: 0 }],
];
for (const [dims, prm] of cases) {
  test(`tray ${dims.W}×${dims.D}×${dims.H} T=${prm.T}: joints interlock with no overlap or gap`, () => {
    const r = assemblyCheck(dims, prm);
    assert.strictEqual(r.overlaps, 0, `overlaps ${r.overlaps}/${r.pts}`);
    assert.strictEqual(r.gaps, 0, `gaps ${r.gaps}/${r.pts}`);
    assert.strictEqual(r.strays, 0, `strays ${r.strays}/${r.pts}`);
  });
}
const G2 = G;
const divCases = [
  [{ W: 200, D: 120, H: 63.5, dividers: { x: G2.evenDividers(200, 6.35, 2), y: [] } }, { T: 6.35 }, 'two dividers across the width'],
  [{ W: 150, D: 220, H: 63.5, dividers: { x: [], y: G2.evenDividers(220, 6.35, 3) } }, { T: 6.35 }, 'three dividers across the depth'],
  [{ W: 240, D: 180, H: 70, dividers: { x: G2.evenDividers(240, 6.35, 2), y: G2.evenDividers(180, 6.35, 1) } }, { T: 6.35 }, 'egg-crate 3×2 with half-laps'],
  [{ W: 160, D: 160, H: 60, dividers: { x: [60, 110], y: [50] } }, { T: 6, divDrop: 12 }, 'uneven crossing dividers, dropped 12 mm'],
];
for (const [dims, prm, label] of divCases) {
  test(`dividers: ${label} interlock with no overlap or gap`, () => {
    const r = assemblyCheck(dims, prm);
    assert.strictEqual(r.box.warnings.length, 0, r.box.warnings.join('; '));
    assert.strictEqual(r.overlaps, 0, `overlaps ${r.overlaps}/${r.pts}`);
    assert.strictEqual(r.gaps, 0, `gaps ${r.gaps}/${r.pts}`);
    assert.strictEqual(r.strays, 0, `strays ${r.strays}/${r.pts}`);
  });
}
const splitCases = [
  [{ W: 320, D: 200, H: 60, floorMax: [{ x: 180, y: 400 }] }, { T: 6.35 }, 2, 'two pieces across the width'],
  [{ W: 300, D: 260, H: 60, floorMax: [{ x: 170, y: 150 }] }, { T: 6.35 }, 4, '2×2 grid with crossing seams'],
  [{ W: 360, D: 240, H: 70, floorMax: [{ x: 200, y: 400 }], dividers: { x: G.evenDividers(360, 6.35, 3), y: G.evenDividers(240, 6.35, 1) } }, { T: 6.35 }, 2, 'seam hidden under a divider of an egg-crate'],
  [{ W: 360, D: 300, H: 70, floorMax: [{ x: 200, y: 170 }], dividers: { x: [120], y: [] } }, { T: 6.35 }, 6, 'one hidden seam, keyed seams elsewhere'],
  [{ W: 330, D: 180, H: 60, floorMax: [{ x: 190, y: 400 }], keepOut: [{ x0: 120, x1: 150, y0: 60, y1: 80 }] }, { T: 6 }, 2, 'seam steers around an engraved label'],
];
for (const [dims, prm, pieces, label] of splitCases) {
  test(`split floor: ${label} (${pieces} pieces) tiles with no overlap or gap`, () => {
    const r = assemblyCheck(dims, prm);
    const floors = r.box.parts.filter(p => p.role === 'floor');
    assert.strictEqual(floors.length, pieces, r.box.warnings.join('; '));
    assert.strictEqual(r.box.warnings.length, 0, r.box.warnings.join('; '));
    for (const f of floors) {
      const c = G.cutGeometry(f, 0.2);
      assert.ok(c.w <= dims.floorMax[0].x + 0.2 + 1e-6 && c.h <= dims.floorMax[0].y + 0.2 + 1e-6, `${f.name} ${c.w.toFixed(1)}×${c.h.toFixed(1)} fits`);
    }
    assert.strictEqual(r.overlaps, 0, `overlaps ${r.overlaps}/${r.pts}`);
    assert.strictEqual(r.gaps, 0, `gaps ${r.gaps}/${r.pts}`);
    assert.strictEqual(r.strays, 0, `strays ${r.strays}/${r.pts}`);
    if (dims.keepOut) {
      const K = G.keyDims(prm.T).L;
      const seamX = r.box.floorSeams[0][0][0];
      assert.ok(seamX < 120 - K || seamX > 150 + K, `seam at ${seamX.toFixed(1)} clears the label`);
    }
  });
}
test('split floor: floor that fits stays whole; impossible split warns', () => {
  const whole = G.buildBox({ W: 200, D: 150, H: 50, floorMax: [{ x: 300, y: 300 }] }, { T: 6 });
  assert.strictEqual(whole.parts.filter(p => p.role === 'floor').length, 1);
  const tiny = G.buildBox({ W: 300, D: 200, H: 50, floorMax: [{ x: 30, y: 30 }] }, { T: 6 });
  assert.ok(tiny.warnings.some(w => /can't be split/.test(w)));
});
test('divider counts and spacing helpers', () => {
  const c = G.evenDividers(200, 6, 3);
  assert.strictEqual(c.length, 3);
  const comp = [c[0] - 3 - 6, c[1] - c[0] - 6, c[2] - c[1] - 6, 200 - 6 - c[2] - 3];
  for (const w of comp) assert.ok(near(w, comp[0]), 'equal compartments');
  assert.ok(G.dividersValid(200, 6, c));
  assert.ok(!G.dividersValid(200, 6, [14]), 'too close to the wall');
  assert.ok(G.maxDividers(60, 6) >= 1 && G.maxDividers(30, 6) === 0);
  const box = G.buildBox({ W: 200, D: 120, H: 60, dividers: { x: c, y: [] } }, { T: 6 });
  assert.strictEqual(box.parts.find(p => p.role === 'dx').placements.length, 3);
  assert.ok(box.parts[0].holes.length > box.parts[1].holes.length, 'front/back walls carry divider slots');
});
test('floor tabs land fully inside wall slots', () => {
  const box = G.buildBox({ W: 140, D: 90, H: 60 }, { T: 6.35 });
  const [fb, lr, floor] = box.parts;
  const fbb = G.bbox(floor.outline);
  assert.ok(near(fbb.w, 140) && near(fbb.h, 90));
  for (const s of fb.holes) { const b = G.bbox(s); assert.ok(b.x0 > 6.35 && b.x1 < 140 - 6.35); }
  for (const s of lr.holes) { const b = G.bbox(s); assert.ok(b.x0 > 6.35 && b.x1 < 90 - 6.35); }
  assert.strictEqual(box.tabsPerSide.x, fb.holes.length);
});

console.log('engraving');
const EN = require('../js/engrave.js');
// Fake font: every character is an "L" glyph (stem on the left, foot at the bottom),
// so mirroring or misplacement is detectable.
const fakeShaper = (text, capH) => {
  const cmds = [];
  const w = capH * 0.6;
  [...text].forEach((ch, k) => {
    const x = k * w * 1.2, t = capH * 0.15;
    const pts = [[x, 0], [x + w, 0], [x + w, t], [x + t, t], [x + t, capH], [x, capH]];
    cmds.push({ t: 'M', p: [pts[0]] }, ...pts.slice(1).map(p => ({ t: 'L', p: [p] })), { t: 'Z', p: [] });
  });
  return { cmds, x0: 0, x1: text.length * w * 1.2 - w * 0.2 };
};
test('labels land in the right compartment, readable from above, in the exported floor', () => {
  const W = 200, D = 120, T = 6, divs = { x: [W / 2], y: [D / 2] };
  const box = G.buildBox({ W, D, H: 50, dividers: divs }, { T });
  const floor = box.parts.find(p => p.role === 'floor');
  // label only the back-left compartment (layout top-left: i = 0, j = 0)
  floor.engrave = EN.floorEngraving(W, D, T, divs, { '0,0': 'LL' }, { capH: 8, pad: 3 }, fakeShaper).cmds;
  const cut = G.cutGeometry(floor, 0);
  const svg = X.svgDoc(cut.w, cut.h, [cut], {});
  const m = svg.match(/<g id="engrave-area"[^>]*>\s*<path d="([^"]+)"/);
  assert.ok(m, 'area engrave group present');
  const nums = m[1].match(/-?\d+(\.\d+)?/g).map(Number);
  const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
  // screen view of the file == view into the tray from above: back-left = top-left
  assert.ok(Math.max(...xs) < W / 2 && Math.max(...ys) < D / 2, 'label sits in the back-left compartment');
  // not mirrored: first glyph's stem (leftmost x) spans the full cap height and its foot is at the bottom (larger screen y)
  const first = EN.flatten(EN.mapCmds(cut.engrave, ([x, y]) => [x, cut.h - y]))[0];
  const minX = Math.min(...first.map(p => p[0])), maxY = Math.max(...first.map(p => p[1]));
  const foot = first.filter(p => Math.abs(p[1] - maxY) < 1e-6).map(p => p[0]);
  assert.ok(Math.max(...foot) - minX > 8 * 0.5, 'foot extends right from the stem, i.e. not mirrored');
  const dxf = X.dxfDoc([cut], 'mm');
  assert.ok(/\r\n8\r\nENGRAVE\r\n/.test(dxf), 'DXF has ENGRAVE layer entities');
  assert.ok(svg.indexOf('engrave-area') < svg.indexOf('cut-inner'), 'engrave before cuts');
});
test('rotated labels turn counter-clockwise and fit the rotated space', () => {
  const cell = { u0: 0, u1: 20, v0: 0, v1: 100 }; // tall, narrow compartment
  const flat = EN.layoutLabel('LLLLLL', cell, { capH: 6, pad: 1 }, fakeShaper, 0);
  const up = EN.layoutLabel('LLLLLL', cell, { capH: 6, pad: 1 }, fakeShaper, 90);
  assert.ok(flat.shrunk && !up.shrunk, 'reads along the long side without shrinking');
  const bb = G.bbox(EN.flatten(up.cmds).flat());
  assert.ok(bb.h > bb.w && bb.x0 >= 1 - 1e-6 && bb.x1 <= 19 + 1e-6 && bb.y0 >= 1 - 1e-6 && bb.y1 <= 99 + 1e-6, 'stays inside the cell');
  // first glyph of a 90° label sits at the bottom (reads bottom to top), its stem toward +x... foot toward -x
  const first = EN.flatten(up.cmds)[0], fb = G.bbox(first);
  assert.ok(fb.y0 < (bb.y0 + bb.y1) / 2, 'first letter at the bottom');
  const r180 = EN.layoutLabel('LL', { u0: 0, u1: 100, v0: 0, v1: 40 }, { capH: 6 }, fakeShaper, 180);
  const f180 = G.bbox(EN.flatten(r180.cmds)[0]), all180 = G.bbox(EN.flatten(r180.cmds).flat());
  assert.ok(f180.x1 > (all180.x0 + all180.x1) / 2, '180°: first letter on the right');
});
test('long labels shrink to fit and report it', () => {
  const r = EN.layoutLabel('A very long label indeed', { u0: 0, u1: 40, v0: 0, v1: 30 }, { capH: 8, pad: 2, minCapH: 3 }, fakeShaper);
  const bb = G.bbox(EN.flatten(r.cmds).flat());
  assert.ok(r.shrunk && bb.x0 >= 2 - 1e-6 && bb.x1 <= 38 + 1e-6, `fits: ${bb.x0}..${bb.x1}`);
  assert.ok(r.tooSmall, 'flags text under the minimum height');
});

console.log('layout');
test('split, resize and merge keep the drawer tiled', () => {
  const rect = { x: 0, y: 0, w: 400, h: 300 };
  let root = L.leaf();
  let r = L.splitLeaf(root, root.id, 'x', 3); root = r.root;
  r = L.splitLeaf(root, r.ids[1], 'y', 2); root = r.root;
  let c = L.compute(root, rect);
  assert.strictEqual(c.leaves.length, 4);
  const area = () => L.compute(root, rect).leaves.reduce((s, l) => s + l.rect.w * l.rect.h, 0);
  assert.ok(near(area(), 400 * 300));
  const div = c.dividers.find(d => d.dir === 'x');
  L.moveDivider(root, rect, div.splitId, div.index, 200, 30);
  c = L.compute(root, rect);
  assert.ok(near(c.leaves[0].rect.w, 200));
  assert.ok(near(area(), 400 * 300));
  const target = c.leaves[1].node.id;
  L.setLeafSize(root, rect, target, 'y', 100, 30);
  c = L.compute(root, rect);
  assert.ok(near(c.leaves.find(l => l.node.id === target).rect.h, 100));
  const m = L.mergeLeaf(root, target, 'next'); root = m.root;
  c = L.compute(root, rect);
  assert.strictEqual(c.leaves.length, 3);
  assert.ok(near(area(), 400 * 300));
  // the merged column collapses to a plain leaf, so the root is a flat 3-column split
  assert.strictEqual(root.kind, 'split'); assert.strictEqual(root.children.length, 3);
});
test('splitting along the parent direction flattens', () => {
  let root = L.grid(2, 1);
  const id = root.children[0].id;
  root = L.splitLeaf(root, id, 'x', 2).root;
  assert.strictEqual(root.children.length, 3);
  assert.ok(near(root.weights.reduce((a, b) => a + b), 2));
});

console.log('nesting');
test('parts stay on the sheet and never overlap', () => {
  const items = [];
  for (let i = 0; i < 40; i++) items.push({ id: i, w: 40 + (i * 37) % 200, h: 30 + (i * 53) % 90, grainRot: i % 5 === 0 ? 90 : 0 });
  const W = 609.6, H = 304.8, margin = 6, sp = 3;
  for (const allowRotate of [false, true]) {
    const { sheets, unplaced } = N.pack(items, W, H, { margin, spacing: sp, allowRotate });
    assert.strictEqual(unplaced.length, 0);
    assert.strictEqual(sheets.reduce((s, sh) => s + sh.items.length, 0), items.length);
    for (const sh of sheets) {
      for (const a of sh.items) {
        assert.ok(a.x >= margin - 1e-6 && a.y >= margin - 1e-6 && a.x + a.w <= W - margin + 1e-6 && a.y + a.h <= H - margin + 1e-6, 'inside margins');
        if (!allowRotate) assert.strictEqual(a.rot, a.item.grainRot || 0, 'grain respected');
        for (const b of sh.items) {
          if (a === b) continue;
          const sep = a.x + a.w + sp <= b.x + 1e-6 || b.x + b.w + sp <= a.x + 1e-6 || a.y + a.h + sp <= b.y + 1e-6 || b.y + b.h + sp <= a.y + 1e-6;
          assert.ok(sep, 'spacing respected');
        }
      }
    }
  }
});
test('oversize parts are reported, not dropped silently', () => {
  const { unplaced } = N.pack([{ id: 1, w: 900, h: 10 }], 600, 300, { margin: 5, spacing: 2 });
  assert.strictEqual(unplaced.length, 1);
});

console.log('export');
test('DXF is well-formed group-code pairs with closed polylines', () => {
  const box = G.buildBox({ W: 100, D: 80, H: 50 }, { T: 6.35 });
  const cut = G.cutGeometry(box.parts[0], 0.15);
  const dxf = X.dxfDoc([cut], 'in');
  const lines = dxf.trim().split('\r\n');
  assert.strictEqual(lines.length % 2, 0);
  for (let i = 0; i < lines.length; i += 2) assert.ok(/^\s*-?\d+$/.test(lines[i]), 'group code at line ' + i);
  assert.strictEqual(lines[lines.length - 1], 'EOF');
  const polys = lines.filter(l => l === 'POLYLINE').length;
  assert.strictEqual(polys, 1 + cut.holes.length);
});
test('SVG uses physical mm and blue hairline cuts', () => {
  const box = G.buildBox({ W: 100, D: 80, H: 50 }, { T: 6.35 });
  const cut = G.cutGeometry(box.parts[2], 0);
  const svg = X.svgDoc(cut.w, cut.h, [cut], { hairline: true });
  assert.ok(svg.includes('width="100mm"') && svg.includes('height="80mm"'));
  assert.ok(svg.includes('stroke="#0000FF"') && svg.includes('stroke-width="0.01"'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
