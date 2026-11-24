/*
 * Manufacturing file writers. Inputs are millimetre polygons (y-up).
 *   SVG: physical mm units, pure-blue (#0000FF) cut strokes, no fills,
 *        inner cuts (slots) listed before outer cuts.
 *   DXF: AutoCAD R12 ASCII, closed POLYLINEs on layer CUT, inches or mm.
 * Engraving (Ponoko's recommended colours, assignable after upload):
 *   area engrave = gray fill (#808080), line engrave = red stroke (#FF0000).
 *   In DXF, engraving outlines go on layer ENGRAVE (red).
 * Order in every file: engraving, inner cuts, outer cuts, so a part is never
 * cut free before it has been engraved and slotted.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.Export = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const num = (n, d) => String(+n.toFixed(d));

  /** Transform a nested item's cut geometry into sheet coordinates. */
  function placeItem(si) {
    const g = si.item.cut, x = si.x, y = si.y;
    const tf = si.rot === 90 ? p => [x + (g.h - p[1]), y + p[0]] : p => [x + p[0], y + p[1]];
    return {
      outline: g.outline.map(tf), holes: g.holes.map(h => h.map(tf)),
      engrave: g.engrave ? g.engrave.map(c => ({ t: c.t, p: c.p.map(tf) })) : null,
    };
  }

  function svgDoc(w, h, shapes, opts) {
    opts = opts || {};
    const sw = opts.hairline ? 0.01 : 0.1;
    const d = poly => 'M' + poly.map(p => num(p[0], 4) + ' ' + num(h - p[1], 4)).join(' L') + ' Z';
    const inner = [], outer = [], engr = [];
    const E = typeof Engrave !== 'undefined' ? Engrave : require('./engrave.js');
    for (const s of shapes) if (s.engrave && s.engrave.length) engr.push(`    <path d="${E.svgPathData(s.engrave, y => h - y)}"/>`);
    for (const s of shapes) {
      for (const hole of s.holes) inner.push(`    <path d="${d(hole)}"/>`);
      outer.push(`    <path d="${d(s.outline)}"/>`);
    }
    const title = opts.title ? `  <title>${String(opts.title).replace(/[<&>]/g, '')}</title>\n` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${num(w, 3)}mm" height="${num(h, 3)}mm" viewBox="0 0 ${num(w, 3)} ${num(h, 3)}">
${title}${engr.length ? (opts.engraveStyle === 'line'
      ? `  <g id="engrave-line" fill="none" stroke="#FF0000" stroke-width="${sw}">\n${engr.join('\n')}\n  </g>\n`
      : `  <g id="engrave-area" fill="#808080" stroke="none">\n${engr.join('\n')}\n  </g>\n`) : ''}  <g id="cut" fill="none" stroke="#0000FF" stroke-width="${sw}" stroke-linejoin="miter">
  <g id="cut-inner">
${inner.join('\n')}
  </g>
  <g id="cut-outer">
${outer.join('\n')}
  </g>
  </g>
</svg>
`;
  }

  function dxfDoc(shapes, units) {
    const inches = units === 'in';
    const k = inches ? 1 / 25.4 : 1;
    const out = [];
    const g = (code, val) => { out.push(String(code)); out.push(String(val)); };
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$INSUNITS'); g(70, inches ? 1 : 4);
    g(9, '$MEASUREMENT'); g(70, inches ? 0 : 1);
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, 2);
    g(0, 'LAYER'); g(2, 'CUT'); g(70, 0); g(62, 5); g(6, 'CONTINUOUS');
    g(0, 'LAYER'); g(2, 'ENGRAVE'); g(70, 0); g(62, 1); g(6, 'CONTINUOUS');
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    const poly = (pts, layer, color) => {
      layer = layer || 'CUT'; color = color || 5;
      g(0, 'POLYLINE'); g(8, layer); g(62, color); g(66, 1); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(70, 1);
      for (const [x, y] of pts) { g(0, 'VERTEX'); g(8, layer); g(10, num(x * k, 6)); g(20, num(y * k, 6)); g(30, '0.0'); }
      g(0, 'SEQEND'); g(8, layer);
    };
    const E = typeof Engrave !== 'undefined' ? Engrave : require('./engrave.js');
    for (const s of shapes) if (s.engrave && s.engrave.length) for (const pl of E.flatten(s.engrave)) poly(pl, 'ENGRAVE', 1);
    for (const s of shapes) for (const h of s.holes) poly(h);
    for (const s of shapes) poly(s.outline);
    g(0, 'ENDSEC'); g(0, 'EOF');
    return out.join('\r\n') + '\r\n';
  }

  function csv(rows) {
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
  }

  return { placeItem, svgDoc, dxfDoc, csv };
});
