/* FingerPrint: UI and orchestration. */
(function () {
  'use strict';
  const G = window.BoxGeom, L = window.Layout, N = window.Nest, X = window.Export, E = window.Engrave;
  const IN = 25.4;
  const STORE = 'tray-joinery/v1';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const PRESETS = [
    { id: '24x12', label: '24 × 12 in', W: 24 * IN, H: 12 * IN },
    { id: '20x12', label: '20 × 12 in', W: 20 * IN, H: 12 * IN },
    { id: '24x18', label: '24 × 18 in', W: 24 * IN, H: 18 * IN },
    { id: '48x24', label: '48 × 24 in', W: 48 * IN, H: 24 * IN },
    { id: 'P3', label: 'Ponoko P3 · 790×384 mm', W: 790, H: 384 },
    { id: 'P2', label: 'Ponoko P2 · 384×384 mm', W: 384, H: 384 },
    { id: 'custom', label: 'Custom' },
  ];

  /* ------------------------------------------------------------- state */

  function defaultTree() {
    // Like the photo: a column of small square trays beside longer ones.
    return L.split('x', [
      L.split('y', [L.leaf(), L.leaf(), L.leaf()]),
      L.split('y', [L.leaf(), L.leaf()], [8, 10]),
    ], [6, 10]);
  }

  function defaultState() {
    return {
      v: 1, units: 'in',
      drawer: { W: 16.125 * IN, D: 18.125 * IN },
      clearance: 0.125 * IN, gap: IN / 32, snap: 0.25 * IN,
      height: 2.5 * IN, sets: 1,
      T: 0.25 * IN, kerf: 0,
      finger: 0.375 * IN, lift: 0.125 * IN, tabW: 0.5 * IN, tabPitch: 1 * IN, divDrop: 0,
      sheet: { preset: '24x12', W: 24 * IN, H: 12 * IN, margin: 0.25 * IN, spacing: 0.125 * IN, allowRotate: false, splitFloors: true },
      engrave: { font: 'fraunces', capH: 0.25 * IN, style: 'area' },
      exp: { dxfUnits: 'in', hairline: false },
      tree: defaultTree(),
    };
  }

  function merge(base, over) {
    for (const k of Object.keys(over || {})) {
      const v = over[k];
      if (k !== 'tree' && v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
      else base[k] = v;
    }
    return base;
  }

  function validTree(n) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') return false;
    if (n.kind === 'leaf') return true;
    return n.kind === 'split' && (n.dir === 'x' || n.dir === 'y') && Array.isArray(n.children) && n.children.length > 0 &&
      Array.isArray(n.weights) && n.weights.length === n.children.length && n.children.every(validTree);
  }

  function fromJSON(obj) {
    if (!obj || !obj.drawer || !validTree(obj.tree)) return null;
    return merge(defaultState(), obj);
  }

  function load() {
    try { const raw = localStorage.getItem(STORE); return raw ? fromJSON(JSON.parse(raw)) : null; } catch (e) { return null; }
  }
  function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage unavailable */ } }

  let state = load() || defaultState();
  let model = null;
  let selected = null;
  let view = 'layout';
  const dirty = { sheets: true, list: true, three: true };
  const undoStack = [], redoStack = [];

  function pushHistory() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 150) undoStack.shift();
    redoStack.length = 0;
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(state));
    state = JSON.parse(undoStack.pop());
    after();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(state));
    state = JSON.parse(redoStack.pop());
    after();
  }
  function after() { persist(); rebuild(); syncInputs(); renderAll(); }
  function commit(fn, opts) {
    if (!opts || opts.history !== false) pushHistory();
    if (fn) fn(state);
    after();
  }

  /* ------------------------------------------------------------- model */

  const params = () => ({ T: state.T, finger: state.finger, lift: state.lift, tabW: state.tabW, tabPitch: state.tabPitch, divDrop: state.divDrop, kerf: state.kerf });
  const usableRect = () => { const c = state.clearance; return { x: c / 2, y: c / 2, w: state.drawer.W - c, h: state.drawer.D - c }; };
  const minCell = () => Math.max(2 * state.T + state.tabW + 4, 20) + state.gap;
  const fmt = v => G.formatLength(v, state.units);
  const unitSuffix = () => (state.units === 'in' ? '"' : ' mm');
  const fmtU = v => fmt(v) + unitSuffix();

  function letterFor(i) {
    let s = '';
    i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function partName(type, part) {
    const W = type.geom.parts[0].w, D = type.geom.parts[1].w; // front/back length, left/right length
    const square = Math.abs(W - D) < 0.01;
    const LW = { name: 'Long wall', code: 'L', slug: 'long-wall' }, EW = { name: 'End wall', code: 'E', slug: 'end-wall' };
    const LD = { name: 'Long divider', code: 'LD', slug: 'long-divider' }, SD = { name: 'Short divider', code: 'SD', slug: 'short-divider' };
    if (part.role === 'fb') return square ? { name: 'Wall A', code: 'WA', slug: 'wall-a' } : (W > D ? LW : EW);
    if (part.role === 'lr') return square ? { name: 'Wall B', code: 'WB', slug: 'wall-b' } : (D > W ? LW : EW);
    if (part.role === 'dx') return square ? { name: 'Divider A', code: 'DA', slug: 'divider-a' } : (D > W ? LD : SD); // runs along D
    if (part.role === 'dy') return square ? { name: 'Divider B', code: 'DB', slug: 'divider-b' } : (W > D ? LD : SD); // runs along W
    if (part.piece) return { name: `Floor piece ${part.piece.index} of ${part.piece.of}`, code: `F${part.piece.index}`, slug: `floor-${part.piece.index}of${part.piece.of}` };
    return { name: 'Floor', code: 'F', slug: 'floor' };
  }

  /* ----------------------------------------------------------- engraving */

  const FONTS = {
    fraunces: { label: 'Fraunces (serif)', url: 'https://cdn.jsdelivr.net/npm/@fontsource/fraunces@5.0.21/files/fraunces-latin-600-normal.woff' },
    sans: { label: 'Instrument Sans', url: 'https://cdn.jsdelivr.net/npm/@fontsource/instrument-sans@5.1.0/files/instrument-sans-latin-600-normal.woff' },
    mono: { label: 'IBM Plex Mono', url: 'https://cdn.jsdelivr.net/npm/@fontsource/ibm-plex-mono@5.0.13/files/ibm-plex-mono-latin-500-normal.woff' },
    script: { label: 'Caveat (handwritten)', url: 'https://cdn.jsdelivr.net/npm/@fontsource/caveat@5.0.17/files/caveat-latin-600-normal.woff' },
  };
  const fontCache = {};
  function shaperFor(id) {
    const f = fontCache[id];
    if (f) return f.status === 'ok' ? f.shaper : null;
    fontCache[id] = { status: 'loading' };
    if (!window.opentype) { fontCache[id] = { status: 'error' }; return null; }
    fetch(FONTS[id].url).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
      .then(buf => { fontCache[id] = { status: 'ok', shaper: E.makeShaper(window.opentype.parse(buf)) }; })
      .catch(() => { fontCache[id] = { status: 'error' }; })
      .then(() => { rebuild(); renderAll(); });
    return null;
  }
  function fontStatus() { const f = fontCache[state.engrave.font]; return f ? f.status : 'idle'; }

  /* A tray's labels (and their rotations), limited to compartments that exist. */
  function trayLabels(t) {
    const lb = t.node.labels;
    if (!lb) return null;
    const nx = t.divs.x.length + 1, ny = t.divs.y.length + 1, labels = {}, rots = {};
    for (const [k, v] of Object.entries(lb)) {
      const [i, j] = k.split(',').map(Number);
      if (i < nx && j < ny && String(v).trim()) {
        labels[k] = String(v).trim();
        const r = t.node.labelRot && t.node.labelRot[k];
        if (r) rots[k] = r;
      }
    }
    return Object.keys(labels).length ? { labels, rots } : null;
  }

  /* Engraving for a floor in its real orientation, or a pending/failed status. */
  function engravingFor(W, D, divs, lab) {
    const shaper = shaperFor(state.engrave.font);
    if (!shaper) return { status: fontStatus() === 'error' ? 'failed' : 'pending', cmds: [], notes: [], boxes: [] };
    const r = E.floorEngraving(W, D, state.T, divs, lab.labels,
      { capH: state.engrave.capH, pad: Math.max(state.T * 0.6, 3), minCapH: 3 }, shaper, lab.rots);
    return Object.assign({ status: 'ok' }, r);
  }

  /* Largest floor piece the stock takes, per allowed orientation (box axes). */
  function floorMaxFor(W, D) {
    const s = state.sheet;
    if (!s.splitFloors) return [];
    const Wu = s.W - 2 * s.margin - state.kerf - 0.3, Hu = s.H - 2 * s.margin - state.kerf - 0.3;
    if (s.allowRotate) return [{ x: Wu, y: Hu }, { x: Hu, y: Wu }];
    return [W >= D - 0.01 ? { x: Wu, y: Hu } : { x: Hu, y: Wu }]; // floor grain runs along its long side
  }

  /* Build a tray: split oversized floors around any engraving, then engrave. */
  function trayBox(W, D, H, divs, lab, prm) {
    const eng = lab ? engravingFor(W, D, divs, lab) : null;
    const keepOut = eng ? eng.boxes.map(b => ({ x0: b.u0, x1: b.u1, y0: D - b.v1, y1: D - b.v0 })) : [];
    const box = G.buildBox({ W, D, H, dividers: divs, floorMax: floorMaxFor(W, D), keepOut }, prm);
    if (eng && eng.cmds.length) {
      const floors = box.parts.filter(p => p.role === 'floor');
      if (floors.length === 1) floors[0].engrave = eng.cmds;
      else {
        for (const f of floors) f.engrave = [];
        for (const sp of E.subpaths(eng.cmds)) {
          const pts = [].concat(...E.flatten(sp, 1));
          if (!pts.length) continue;
          const cu = pts.reduce((a, p) => a + p[0], 0) / pts.length, cv = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          const f = floors.find(q => cu >= q.cell.u0 && cu <= q.cell.u1 && cv >= q.cell.v0 && cv <= q.cell.v1) || floors[0];
          f.engrave.push(...sp);
        }
      }
    }
    return { box, eng };
  }

  /* Divider centres (mm, tray coordinates) from a leaf's divider spec:
     node.div = { x: { n, f: [fractions] | null }, y: {...} }; f null = even. */
  function trayDividers(node, W, D) {
    const T = state.T, dv = node.div || {};
    const axis = (spec, Lo) => {
      if (!spec || !spec.n) return [];
      const n = Math.min(spec.n, G.maxDividers(Lo, T));
      if (!n) return [];
      if (spec.f && spec.f.length === n) {
        const c = spec.f.map(f => T + f * (Lo - 2 * T));
        if (G.dividersValid(Lo, T, c)) return c;
      }
      return G.evenDividers(Lo, T, n);
    };
    return { x: axis(dv.x, W), y: axis(dv.y, D) };
  }

  /* A mirrored layout uses the same parts (flip them over), so pick one canonical form. */
  function canonDividers(cs, Lo) {
    const a = cs.slice().sort((p, q) => p - q), b = cs.map(c => Lo - c).sort((p, q) => p - q);
    const ka = a.map(v => v.toFixed(1)).join(','), kb = b.map(v => v.toFixed(1)).join(',');
    return ka <= kb ? a : b;
  }

  function compartments(cs, Lo) {
    const T = state.T, out = [];
    let prev = T;
    for (const c of cs) { out.push(c - T / 2 - prev); prev = c + T / 2; }
    out.push(Lo - T - prev);
    return out;
  }

  function perimeter(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    return s;
  }

  function rebuild(opts) {
    const nest = !opts || opts.nest !== false;
    const prm = params();
    const ur = usableRect();
    const comp = L.compute(state.tree, ur);
    const g = state.gap;
    const trays = comp.leaves.map(l => ({
      id: l.node.id, node: l.node, cell: l.rect,
      x: l.rect.x + g / 2, y: l.rect.y + g / 2, W: l.rect.w - g, D: l.rect.h - g,
      H: l.node.h || state.height,
    }));
    for (const t of trays) t.divs = trayDividers(t.node, t.W, t.D);
    const types = new Map();
    let engravePending = false, engraveFailed = false;
    const engraveNotes = [];
    const canonCache = new Map();
    for (const t of trays) {
      t.labels = trayLabels(t);
      // Canonical grouping (transpose/mirror) is only safe for symmetric floors:
      // engraved or split floors keep the tray's real orientation.
      let canon = null;
      if (!t.labels) {
        const swap = t.W < t.D;
        const a = swap ? t.D : t.W, b = swap ? t.W : t.D;
        const cx = canonDividers(swap ? t.divs.y : t.divs.x, a), cy = canonDividers(swap ? t.divs.x : t.divs.y, b);
        const key = `${a.toFixed(2)}x${b.toFixed(2)}x${t.H.toFixed(2)}|${cx.map(v => v.toFixed(1))}|${cy.map(v => v.toFixed(1))}`;
        if (!canonCache.has(key)) canonCache.set(key, trayBox(a, b, t.H, { x: cx, y: cy }, null, prm).box);
        const geom = canonCache.get(key);
        if (geom.floorPieces <= 1) canon = { key, a, b, cx, cy, geom };
      }
      if (!canon) {
        // Engraved floors have a readable side, so keep the tray's real orientation
        // (no mirroring/transposing into a canonical type).
        const key = `R|${t.W.toFixed(2)}x${t.D.toFixed(2)}x${t.H.toFixed(2)}|${t.divs.x.map(v => v.toFixed(1))}|${t.divs.y.map(v => v.toFixed(1))}|${JSON.stringify(t.labels)}`;
        let ty = types.get(key);
        if (!ty) {
          const { box, eng } = trayBox(t.W, t.D, t.H, t.divs, t.labels, prm);
          ty = { key, a: t.W, b: t.D, H: t.H, divs: t.divs, labels: t.labels, count: 0, trays: [], letter: letterFor(types.size), geom: box };
          engravePending = engravePending || (!!eng && eng.status === 'pending'); engraveFailed = engraveFailed || (!!eng && eng.status === 'failed');
          if (eng) for (const nte of eng.notes) engraveNotes.push(`Tray ${ty.letter}: ${nte}`);
          types.set(key, ty);
        }
        ty.count++; ty.trays.push(t); t.type = ty;
        t.bad = ty.geom.warnings.some(w => /too small/.test(w));
        continue;
      }
      const { key, a, b, cx, cy, geom } = canon;
      let ty = types.get(key);
      if (!ty) {
        ty = { key, a, b, H: t.H, divs: { x: cx, y: cy }, count: 0, trays: [], letter: letterFor(types.size), geom };
        types.set(key, ty);
      }
      ty.count++; ty.trays.push(t); t.type = ty;
      t.bad = ty.geom.warnings.some(w => /too small/.test(w));
    }
    const typeList = Array.from(types.values());

    const warnings = [];
    for (const ty of typeList) for (const w of ty.geom.warnings) warnings.push(`Tray ${ty.letter}: ${w}`);
    warnings.push(...engraveNotes);
    if (engraveFailed) warnings.push("The engraving font couldn't load (are you offline?), so labels are left out.");
    if (state.drawer.W - state.clearance <= 0 || state.drawer.D - state.clearance <= 0) warnings.push('Clearance is larger than the drawer.');

    const uniqueParts = [], items = [];
    for (const ty of typeList) {
      for (const part of ty.geom.parts) {
        const cut = G.cutGeometry(part, state.kerf);
        const nm = partName(ty, part);
        const qty = part.placements.length * ty.count * state.sets;
        const up = {
          type: ty, part, cut, qty, ...nm,
          grainRot: part.grain === 'y' ? 90 : 0,
          area: G.polyArea(cut.outline, cut.holes),
          cutLen: perimeter(cut.outline) + cut.holes.reduce((s, h) => s + perimeter(h), 0),
          sheets: new Set(),
        };
        uniqueParts.push(up);
        for (let i = 0; i < qty; i++) items.push({ id: `${ty.letter}-${nm.code}-${i}`, up, cut, w: cut.w, h: cut.h, grainRot: up.grainRot, set: i % state.sets });
      }
    }

    let sheets = model && !nest ? model.sheets : [], unplaced = model && !nest ? model.unplaced : [];
    if (nest) {
      const s = state.sheet;
      const nopt = { margin: s.margin, spacing: s.spacing, allowRotate: s.allowRotate };
      let res = N.pack(items, s.W, s.H, nopt);
      if (state.sets > 1) {
        // Nesting one set and repeating it is often tighter than nesting everything at once.
        const one = N.pack(items.filter(it => it.set === 0), s.W, s.H, nopt);
        if (!one.unplaced.length && one.sheets.length * state.sets < res.sheets.length) {
          const rep = [];
          for (let k = 0; k < state.sets; k++) for (const sh of one.sheets) rep.push({ w: sh.w, h: sh.h, items: sh.items.map(si => Object.assign({}, si)) });
          res = { sheets: rep, unplaced: [] };
        }
      }
      sheets = res.sheets; unplaced = res.unplaced;
      sheets.forEach((sh, i) => sh.items.forEach(si => si.item.up.sheets.add(i + 1)));
    }
    if (unplaced.length) {
      const names = Array.from(new Set(unplaced.map(u => `${u.up.type.letter} ${u.up.name}`)));
      warnings.push(`${unplaced.length} part${unplaced.length > 1 ? 's' : ''} won't fit on the sheet (${names.join(', ')}). Use larger stock or allow rotation.`);
    }

    const partArea = uniqueParts.reduce((s, u) => s + u.area * u.qty, 0);
    const sheetArea = sheets.length * state.sheet.W * state.sheet.H;
    model = {
      engravePending,
      comp, trays, types: typeList, uniqueParts, items, sheets, unplaced, warnings,
      partCount: items.length,
      yieldPct: sheetArea ? (100 * partArea) / sheetArea : 0,
      cutLen: uniqueParts.reduce((s, u) => s + u.cutLen * u.qty, 0),
    };
    if (selected && !trays.some(t => t.id === selected)) selected = null;
    dirty.sheets = dirty.list = dirty.three = true;
  }

  /* ------------------------------------------------------------ sidebar */

  const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  function setPath(o, p, v) { const ks = p.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }

  function syncInputs() {
    for (const inp of $$('[data-bind]')) {
      const v = getPath(state, inp.dataset.bind), kind = inp.dataset.kind;
      if (kind === 'check') inp.checked = !!v;
      else if (document.activeElement === inp) continue;
      else if (kind === 'len') inp.value = fmt(v);
      else inp.value = String(v);
      inp.classList.remove('bad');
    }
    for (const u of $$('.f .u')) {
      const inp = u.parentElement.querySelector('[data-kind="len"]');
      if (inp) u.textContent = state.units;
    }
    for (const b of $$('#unitSeg button')) b.classList.toggle('on', b.dataset.u === state.units);
    $('#undoBtn').disabled = !undoStack.length;
    $('#redoBtn').disabled = !redoStack.length;
  }

  function flagBad(inp, msg) {
    inp.classList.add('bad');
    toast(msg || "Couldn't read that value.");
    setTimeout(() => { if (document.activeElement !== inp) syncInputs(); }, 1600);
  }

  function onBind(inp) {
    const path = inp.dataset.bind, kind = inp.dataset.kind;
    let v;
    if (kind === 'len') {
      v = G.parseLength(inp.value, state.units);
      const min = inp.dataset.min != null ? +inp.dataset.min : 0.01;
      if (!isFinite(v) || v < min - 1e-9) return flagBad(inp, inp.dataset.min != null ? 'Enter a length of 0 or more.' : 'Enter a positive length.');
      if (path === 'T' && v > 30) return flagBad(inp, 'That is very thick stock. Check the units.');
    } else if (kind === 'int') {
      v = parseInt(inp.value, 10);
      if (!(v >= 1 && v <= 500)) return flagBad(inp, 'Enter a whole number from 1 to 500.');
    } else if (kind === 'check') v = inp.checked;
    else v = inp.value;
    if (getPath(state, path) === v) { syncInputs(); return; }
    commit(st => {
      setPath(st, path, v);
      if (path === 'sheet.preset' && v !== 'custom') { const p = PRESETS.find(q => q.id === v); st.sheet.W = p.W; st.sheet.H = p.H; }
      if (path === 'sheet.W' || path === 'sheet.H') {
        const p = PRESETS.find(q => q.W && Math.abs(q.W - st.sheet.W) < 0.05 && Math.abs(q.H - st.sheet.H) < 0.05);
        st.sheet.preset = p ? p.id : 'custom';
      }
    });
  }

  /* ------------------------------------------------------------- layout */

  function renderLayout() {
    const svg = $('#layoutSvg');
    const { W, D } = state.drawer;
    const pad = Math.max(W, D) * 0.085;
    svg.setAttribute('viewBox', `${-pad} ${-pad} ${W + pad * 1.35} ${D + pad * 1.35}`);
    const T = state.T, dfs = pad * 0.24;
    const ur = usableRect();
    let s = `<defs>
      <pattern id="grainX" patternUnits="userSpaceOnUse" width="80" height="9">
        <rect width="80" height="9" fill="#86573a"/>
        <path d="M0 2.2 Q20 1.2 40 2.6 T80 2.2" stroke="#6c442d" stroke-width=".7" fill="none"/>
        <path d="M0 6.4 Q25 7.4 50 5.8 T80 6.4" stroke="#9a6a4a" stroke-width=".55" fill="none"/>
        <path d="M0 4.4 Q30 4 60 4.9 T80 4.4" stroke="#764b31" stroke-width=".35" fill="none"/>
      </pattern>
      <pattern id="grainY" href="#grainX" patternTransform="rotate(90)"/>
    </defs>`;
    s += `<rect class="drawer-floor" x="0" y="0" width="${W}" height="${D}"/>`;
    if (state.clearance > 0) s += `<rect class="usable" x="${ur.x}" y="${ur.y}" width="${ur.w}" height="${ur.h}"/>`;
    // drafting-style dimension lines
    const y0 = -pad * 0.5, x0 = -pad * 0.5, tk = pad * 0.16;
    s += `<g class="dim">
      <line x1="0" y1="${-pad * 0.15}" x2="0" y2="${y0 - tk}"/><line x1="${W}" y1="${-pad * 0.15}" x2="${W}" y2="${y0 - tk}"/>
      <line x1="0" y1="${y0}" x2="${W}" y2="${y0}"/>
      <path d="M${-tk / 2} ${y0 + tk / 2} L${tk / 2} ${y0 - tk / 2} M${W - tk / 2} ${y0 + tk / 2} L${W + tk / 2} ${y0 - tk / 2}"/>
      <text x="${W / 2}" y="${y0 - dfs * 0.55}" font-size="${dfs}" text-anchor="middle">${esc(fmtU(W))}</text>
      <line x1="${-pad * 0.15}" y1="0" x2="${x0 - tk}" y2="0"/><line x1="${-pad * 0.15}" y1="${D}" x2="${x0 - tk}" y2="${D}"/>
      <line x1="${x0}" y1="0" x2="${x0}" y2="${D}"/>
      <path d="M${x0 - tk / 2} ${tk / 2} L${x0 + tk / 2} ${-tk / 2} M${x0 - tk / 2} ${D + tk / 2} L${x0 + tk / 2} ${D - tk / 2}"/>
      <text x="${x0 - dfs * 0.55}" y="${D / 2}" font-size="${dfs}" text-anchor="middle" transform="rotate(-90 ${x0 - dfs * 0.55} ${D / 2})">${esc(fmtU(D))}</text>
    </g>`;
    s += `<rect class="drawer-wall" x="0" y="0" width="${W}" height="${D}"/>`;

    for (const t of model.trays) {
      const small = Math.min(t.W, t.D);
      const lf = clamp(small * 0.3, 5, 44), mf = clamp(small * 0.08, 3, 7);
      const tiny = small < 50;
      const cx = t.x + t.W / 2, cy = t.y + t.D / 2;
      const ix = Math.min(T, t.W / 3), iy = Math.min(T, t.D / 3);
      const cls = ['tray', t.id === selected && 'sel', tiny && 'tiny', t.bad && 'bad'].filter(Boolean).join(' ');
      const hNote = t.node.h ? ` · h ${fmt(t.H)}` : '';
      s += `<g class="${cls}" data-id="${t.id}">
        <rect class="wall" x="${t.x}" y="${t.y}" width="${Math.max(t.W, 0.1)}" height="${Math.max(t.D, 0.1)}"/>
        <rect class="floor" x="${t.x + ix}" y="${t.y + iy}" width="${Math.max(t.W - 2 * ix, 0.1)}" height="${Math.max(t.D - 2 * iy, 0.1)}" fill="url(#grain${t.W >= t.D ? 'X' : 'Y'})"/>
        ${t.divs.x.map(c => `<rect class="tdiv" x="${t.x + c - T / 2}" y="${t.y + iy}" width="${T}" height="${Math.max(t.D - 2 * iy, 0.1)}"/>`).join('')}
        ${t.divs.y.map(c => `<rect class="tdiv" x="${t.x + ix}" y="${t.y + c - T / 2}" width="${Math.max(t.W - 2 * ix, 0.1)}" height="${T}"/>`).join('')}
        ${engravingSvg(t)}
        <rect class="edge" x="${t.x}" y="${t.y}" width="${Math.max(t.W, 0.1)}" height="${Math.max(t.D, 0.1)}"/>
        ${t.labels
          // labelled trays: keep the floor clear, park the letter in the corner
          ? `<text class="letter corner" x="${t.x + ix + mf * 1.3}" y="${t.y + iy + mf * 1.3}" font-size="${mf * 1.8}">${t.type.letter}</text>`
          : `<text class="letter" x="${cx}" y="${cy - (tiny ? 0 : mf * 0.7)}" font-size="${lf}">${t.type.letter}</text>
        <text class="meas" x="${cx}" y="${cy + lf * 0.5 + mf * 0.3}" font-size="${mf}">${esc(fmt(t.W))} × ${esc(fmt(t.D))}${esc(hNote)}</text>`}
      </g>`;
    }
    const hit = Math.max(state.gap * 2, Math.max(W, D) * 0.014);
    for (const dv of model.comp.dividers) {
      const on = drag && drag.splitId === dv.splitId && drag.index === dv.index ? ' on' : '';
      const data = `data-split="${dv.splitId}" data-index="${dv.index}" data-dir="${dv.dir}"`;
      if (dv.dir === 'x') {
        s += `<rect class="divider x" ${data} x="${dv.pos - hit / 2}" y="${dv.rect.y}" width="${hit}" height="${dv.rect.h}"/>
              <line class="divider-line${on}" x1="${dv.pos}" y1="${dv.rect.y}" x2="${dv.pos}" y2="${dv.rect.y + dv.rect.h}"/>`;
      } else {
        s += `<rect class="divider y" ${data} x="${dv.rect.x}" y="${dv.pos - hit / 2}" width="${dv.rect.w}" height="${hit}"/>
              <line class="divider-line${on}" x1="${dv.rect.x}" y1="${dv.pos}" x2="${dv.rect.x + dv.rect.w}" y2="${dv.pos}"/>`;
      }
    }
    const dh = Math.max(T * 2.2, Math.max(W, D) * 0.011);
    for (const t of model.trays) {
      t.divs.x.forEach((c, k) => { s += `<rect class="tdiv-hit x" data-tray="${t.id}" data-axis="x" data-k="${k}" x="${t.x + c - dh / 2}" y="${t.y + T}" width="${dh}" height="${Math.max(t.D - 2 * T, 0.1)}"/>`; });
      t.divs.y.forEach((c, k) => { s += `<rect class="tdiv-hit y" data-tray="${t.id}" data-axis="y" data-k="${k}" x="${t.x + T}" y="${t.y + c - dh / 2}" width="${Math.max(t.W - 2 * T, 0.1)}" height="${dh}"/>`; });
    }
    svg.innerHTML = s;
  }

  function engravingSvg(t) {
    const g = t.type.geom;
    let out = '';
    // Seams of a split floor (split trays always keep their real orientation).
    for (const pl of g.floorSeams || []) {
      const pts = pl.map(([x, y]) => [t.x + x, t.y + y]);
      out += `<polyline class="seam" points="${pts.map(p => p.join(',')).join(' ')}"/>`;
    }
    if (!t.labels) return out;
    for (const fl of g.parts.filter(p => p.role === 'floor' && p.engrave && p.engrave.length)) {
      // floor frame (u, v = D - y) → drawing (x + u, y + D - v)
      const d = E.svgPathData(E.mapCmds(fl.engrave, ([u, v]) => [t.x + u, v]), v => t.y + t.D - v);
      out += `<path class="engr ${state.engrave.style}" d="${d}"/>`;
    }
    return out;
  }

  let drag = null, ddrag = null;

  function moveTrayDivider(p) {
    const t = model.trays.find(x => x.id === ddrag.id);
    if (!t) return;
    const ax = ddrag.axis, k = ddrag.k, T = state.T, m = G.minCompartment(T);
    const Lo = ax === 'x' ? t.W : t.D;
    const cs = t.divs[ax].slice();
    let pos = ax === 'x' ? p.x - t.x : p.y - t.y;
    const prevFace = k > 0 ? cs[k - 1] + T / 2 : T;
    // snap the width of the compartment in front of this divider
    if (state.snap > 0) pos = prevFace + T / 2 + Math.round((pos - T / 2 - prevFace) / state.snap) * state.snap;
    const lo = prevFace + m + T / 2;
    const hi = (k < cs.length - 1 ? cs[k + 1] - T / 2 : Lo - T) - m - T / 2;
    if (lo > hi) return;
    pos = clamp(pos, lo, hi);
    if (Math.abs(pos - cs[k]) < 1e-6) return;
    cs[k] = pos;
    const node = L.findNode(state.tree, t.id);
    node.div = node.div || {};
    node.div[ax] = { n: cs.length, f: cs.map(c => (c - T) / (Lo - 2 * T)) };
    ddrag.moved = true;
    rebuild({ nest: false });
    renderLayout(); renderInspector();
  }
  function svgPoint(svg, e) {
    const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  function wireLayout() {
    const svg = $('#layoutSvg');
    svg.addEventListener('pointerdown', e => {
      const hd = e.target.closest('.tdiv-hit');
      if (hd) {
        e.preventDefault();
        pushHistory();
        ddrag = { id: hd.dataset.tray, axis: hd.dataset.axis, k: +hd.dataset.k, moved: false };
        svg.setPointerCapture(e.pointerId);
        document.body.classList.add('dragging');
        if (selected !== ddrag.id) select(ddrag.id);
        return;
      }
      const dv = e.target.closest('.divider');
      if (dv) {
        e.preventDefault();
        pushHistory();
        drag = { splitId: dv.dataset.split, index: +dv.dataset.index, dir: dv.dataset.dir, moved: false };
        svg.setPointerCapture(e.pointerId);
        document.body.classList.add('dragging');
        return;
      }
      const tr = e.target.closest('.tray');
      select(tr ? tr.dataset.id : null);
    });
    svg.addEventListener('pointermove', e => {
      if (ddrag) { moveTrayDivider(svgPoint(svg, e)); return; }
      if (!drag) return;
      const p = svgPoint(svg, e), ur = usableRect();
      let pos = drag.dir === 'x' ? p.x : p.y;
      const o = drag.dir === 'x' ? ur.x : ur.y;
      if (state.snap > 0) pos = o + Math.round((pos - o) / state.snap) * state.snap;
      if (L.moveDivider(state.tree, ur, drag.splitId, drag.index, pos, minCell())) {
        drag.moved = true;
        rebuild({ nest: false });
        renderLayout(); renderInspector();
      }
    });
    const end = () => {
      if (!drag && !ddrag) return;
      const moved = (drag || ddrag).moved;
      drag = null; ddrag = null;
      document.body.classList.remove('dragging');
      if (!moved) undoStack.pop();
      after();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }

  function select(id) {
    if (id === selected) return;
    selected = id;
    dirty.three = true;
    renderLayout(); renderInspector();
    if (view === '3d') renderView();
  }

  /* ---------------------------------------------------------- inspector */

  function typeSummary() {
    return model.types.map(ty => `<div><dt><span class="sw-inline">${ty.letter}</span> × ${ty.count}</dt><dd>${esc(fmt(ty.a))} × ${esc(fmt(ty.b))} × ${esc(fmt(ty.H))}</dd></div>`).join('');
  }

  function renderInspector() {
    // Re-rendering replaces the inspector's fields (also when a font finishes
    // loading), so keep the field being typed in focused, with its text and caret.
    const a = document.activeElement, host = $('#inspector');
    const keep = a && host.contains(a) && (a.dataset.label || a.dataset.ins)
      ? { sel: a.dataset.label ? `[data-label="${a.dataset.label}"]` : `[data-ins="${a.dataset.ins}"]`, v: a.value, s: a.selectionStart, e: a.selectionEnd }
      : null;
    renderInspectorHtml();
    if (keep) {
      const n = host.querySelector(keep.sel);
      if (n) { n.value = keep.v; n.focus(); try { n.setSelectionRange(keep.s, keep.e); } catch (err) { /* not a text field */ } }
    }
  }

  function renderInspectorHtml() {
    const el = $('#inspector');
    const t = model.trays.find(x => x.id === selected);
    if (!t) {
      el.innerHTML = `<div class="ins-empty">
        <h3>Lay out the drawer</h3>
        <p>Click a tray to select it. Drag the lines between trays to resize them. Sizes snap to ${esc(fmtU(state.snap))}.</p>
        <p>Trays with the same size share a letter, and their parts are counted together.</p>
        <dl class="facts">${typeSummary()}</dl>
        <div class="kbd">
          <kbd>C</kbd><span>split selection into columns</span>
          <kbd>R</kbd><span>split selection into rows</span>
          <kbd>⌫</kbd><span>merge selection into neighbour</span>
          <kbd>Esc</kbd><span>deselect</span>
          <kbd>⌘Z</kbd><span>undo · ⇧⌘Z redo</span>
          <kbd>1–4</kbd><span>switch views</span>
        </div>
      </div>`;
      return;
    }
    const ty = t.type, g = ty.geom, T = state.T;
    const mo = L.mergeOptions(state.tree, t.id);
    const [pw, nw] = mo.dir === 'x' ? ['◀ left', 'right ▶'] : ['▲ up', 'down ▼'];
    const inside = `${fmt(t.W - 2 * T)} × ${fmt(t.D - 2 * T)} × ${fmt(t.H - g.lift - T)}`;
    const dvs = t.node.div || {};
    const custom = !!((dvs.x && dvs.x.f) || (dvs.y && dvs.y.f));
    const warn = g.warnings.length ? `<div class="warnbox">${g.warnings.map(esc).join('<br>')}</div>` : '';
    el.innerHTML = `
      <div class="ins-head">
        <div class="ins-letter">${ty.letter}</div>
        <div><div class="ins-title">Tray ${ty.letter}</div>
        <div class="ins-sub">${ty.count} in this set${state.sets > 1 ? ` · ${ty.count * state.sets} total` : ''}</div></div>
      </div>
      <div class="ins-grid">
        <div><label>Width</label><input data-ins="W" value="${esc(fmt(t.W))}"></div>
        <div><label>Depth</label><input data-ins="D" value="${esc(fmt(t.D))}"></div>
        <div><label>Height</label><input data-ins="H" value="${t.node.h ? esc(fmt(t.H)) : ''}" placeholder="${esc(fmt(state.height))}"></div>
      </div>
      <dl class="facts">
        <div><dt>Outside</dt><dd>${esc(fmt(t.W))} × ${esc(fmt(t.D))} × ${esc(fmt(t.H))}</dd></div>
        <div><dt title="Inside the walls, measured from the top of the floor">Inside</dt><dd>${esc(inside)}</dd></div>
        <div><dt>Corner fingers</dt><dd>${g.segments} × ${esc(fmt(g.segH))}</dd></div>
        <div><dt>Floor tabs</dt><dd>${g.tabsPerSide.x} + ${g.tabsPerSide.y} per side</dd></div>
        ${g.floorPieces > 1 ? `<div><dt>Floor</dt><dd>${g.floorPieces} pieces${g.floorHiddenSeams ? ` · ${g.floorHiddenSeams} seam${g.floorHiddenSeams > 1 ? 's' : ''} under dividers` : ''}</dd></div>` : ''}
        ${t.divs.x.length ? `<div><dt>Compartments wide</dt><dd>${compartments(t.divs.x, t.W).map(v => fmt(v).replace(/ /g, "\u00a0")).join(" · ")}</dd></div>` : ''}
        ${t.divs.y.length ? `<div><dt>Compartments deep</dt><dd>${compartments(t.divs.y, t.D).map(v => fmt(v).replace(/ /g, "\u00a0")).join(" · ")}</dd></div>` : ''}
      </dl>
      <div class="divbox">
        <div class="divbox-head"><span>Compartments</span>${custom ? '<button class="chip" data-op="even">Space evenly</button>' : ''}</div>
        <div class="steppers">
          <div class="stepper"><i>Wide</i><button class="chip" data-op="div" data-axis="x" data-d="-1" ${t.divs.x.length ? '' : 'disabled'}>−</button><b>${t.divs.x.length + 1}</b><button class="chip" data-op="div" data-axis="x" data-d="1" ${t.divs.x.length < G.maxDividers(t.W, T) ? '' : 'disabled'}>+</button></div>
          <div class="stepper"><i>Deep</i><button class="chip" data-op="div" data-axis="y" data-d="-1" ${t.divs.y.length ? '' : 'disabled'}>−</button><b>${t.divs.y.length + 1}</b><button class="chip" data-op="div" data-axis="y" data-d="1" ${t.divs.y.length < G.maxDividers(t.D, T) ? '' : 'disabled'}>+</button></div>
        </div>
        ${t.divs.x.length + t.divs.y.length ? '<p class="divhint">Drag a divider in the drawing to move it.</p>' : ''}
      </div>
      <div class="divbox engbox">
        <div class="divbox-head"><span>Floor engraving</span><span class="engstat">${fontStatus() === 'loading' ? 'loading font…' : ''}</span></div>
        <div class="englist">
          ${(() => {
            const ws = compartments(t.divs.x, t.W), hs = compartments(t.divs.y, t.D);
            const MW = 26, MH = clamp((MW * t.D) / t.W, 14, 30), g = 1.5;
            const sx = (MW - g * (ws.length + 1)) / ws.reduce((a, b) => a + b, 0), sy = (MH - g * (hs.length + 1)) / hs.reduce((a, b) => a + b, 0);
            const map = (ci, cj) => {
              let r = '', y = g;
              hs.forEach((h, j) => {
                let x = g;
                ws.forEach((w, i) => { r += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(w * sx).toFixed(2)}" height="${(h * sy).toFixed(2)}"${i === ci && j === cj ? ' class="on"' : ''}/>`; x += w * sx + g; });
                y += h * sy + g;
              });
              return `<svg class="engmap" viewBox="0 0 ${MW} ${MH.toFixed(2)}" width="${MW}" height="${MH.toFixed(0)}" aria-hidden="true"><rect class="frame" width="${MW}" height="${MH.toFixed(2)}"/>${r}</svg>`;
            };
            const rows = hs.length, cols = ws.length, many = rows * cols > 1;
            const where = (i, j) => [cols > 1 ? (cols === 2 ? ['Left', 'Right'][i] : `Column ${i + 1}`) : '', rows > 1 ? (rows === 2 ? ['back', 'front'][j] : `row ${j + 1}`) : '']
              .filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase());
            return Array.from({ length: rows }, (_, j) => Array.from({ length: cols }, (_, i) => {
              const k = `${i},${j}`, v = (t.node.labels && t.node.labels[k]) || '';
              const rot = (t.node.labelRot && t.node.labelRot[k]) || 0;
              const arrow = { 0: '→', 90: '↑', 180: '←', 270: '↓' }[rot];
              const name = many ? where(i, j) : 'Whole floor';
              return `<div class="engrow" title="${esc(name)}">${map(i, j)}`
                + `<textarea data-label="${k}" rows="${Math.min(3, Math.max(1, v.split('\n').length))}" placeholder="${esc(name)}" aria-label="Label for ${esc(name.toLowerCase())}" spellcheck="false">${esc(v)}</textarea>`
                + `<button class="rot" data-op="rot" data-k="${k}" title="Rotate this label 90° (now reads ${{ 0: 'left to right', 90: 'bottom to top', 180: 'upside down', 270: 'top to bottom' }[rot]})">${arrow}</button></div>`;
            }).join('')).join('');
          })()}
        </div>
        <p class="divhint">One line per compartment; the map shows which. Shift+Enter adds a second line, and the arrow rotates the label.</p>
      </div>
      <div class="ops">
        <div class="op-row"><span>Split into columns</span>
          <button class="chip" data-op="split" data-dir="x" data-n="2">2</button><button class="chip" data-op="split" data-dir="x" data-n="3">3</button><button class="chip" data-op="split" data-dir="x" data-n="4">4</button></div>
        <div class="op-row"><span>Split into rows</span>
          <button class="chip" data-op="split" data-dir="y" data-n="2">2</button><button class="chip" data-op="split" data-dir="y" data-n="3">3</button><button class="chip" data-op="split" data-dir="y" data-n="4">4</button></div>
        <div class="op-row"><span>Merge</span>
          <button class="chip" data-op="merge" data-side="prev" ${mo.prev ? '' : 'disabled'}>${pw}</button>
          <button class="chip" data-op="merge" data-side="next" ${mo.next ? '' : 'disabled'}>${nw}</button></div>
        <div class="op-row"><span>Replace group with one tray</span>
          <button class="chip" data-op="collapse" ${mo.dir ? '' : 'disabled'}>Merge all</button></div>
      </div>
      ${warn}`;
  }

  function wireInspector() {
    const el = $('#inspector');
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-op]');
      if (!b || b.disabled || !selected) return;
      const op = b.dataset.op;
      if (op === 'split') splitSel(b.dataset.dir, +b.dataset.n);
      else if (op === 'merge') mergeSel(b.dataset.side);
      else if (op === 'div') {
        const ax = b.dataset.axis, t = model.trays.find(x => x.id === selected);
        const n = clamp(t.divs[ax].length + (+b.dataset.d), 0, G.maxDividers(ax === 'x' ? t.W : t.D, state.T));
        commit(() => {
          const node = L.findNode(state.tree, selected);
          node.div = node.div || {};
          if (n) node.div[ax] = { n, f: null }; else delete node.div[ax];
          if (!node.div.x && !node.div.y) delete node.div;
        });
      } else if (op === 'rot') commit(() => {
        const node = L.findNode(state.tree, selected), k = b.dataset.k;
        const next = (((node.labelRot && node.labelRot[k]) || 0) + 90) % 360;
        node.labelRot = Object.assign({}, node.labelRot);
        if (next) node.labelRot[k] = next; else delete node.labelRot[k];
        if (!Object.keys(node.labelRot).length) delete node.labelRot;
      });
      else if (op === 'even') commit(() => {
        const node = L.findNode(state.tree, selected);
        for (const ax of ['x', 'y']) if (node.div && node.div[ax]) node.div[ax].f = null;
      });
      else if (op === 'collapse') commit(st => { const r = L.collapseParent(st.tree, selected); st.tree = r.root; selected = r.keep; });
    });
    el.addEventListener('change', e => {
      const ta = e.target.closest('[data-label]');
      if (ta && selected) {
        const k = ta.dataset.label, v = ta.value.replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 3).join('\n');
        commit(() => {
          const node = L.findNode(state.tree, selected);
          node.labels = Object.assign({}, node.labels);
          if (v) node.labels[k] = v; else delete node.labels[k];
          if (!Object.keys(node.labels).length) delete node.labels;
        });
        return;
      }
      const inp = e.target.closest('[data-ins]');
      if (!inp || !selected) return;
      const k = inp.dataset.ins;
      if (k === 'H' && !inp.value.trim()) {
        commit(st => { const n = L.findNode(st.tree, selected); if (n) delete n.h; });
        return;
      }
      const v = G.parseLength(inp.value, state.units);
      if (!isFinite(v) || v <= 0) { inp.classList.add('bad'); toast("Couldn't read that value."); return; }
      if (k === 'H') {
        if (v < 3 * state.T) { inp.classList.add('bad'); toast('Height must be at least three times the material thickness.'); return; }
        commit(st => { const n = L.findNode(st.tree, selected); if (n) n.h = Math.abs(v - st.height) < 0.01 ? undefined : v; });
        return;
      }
      const snapshot = JSON.stringify(state);
      const ok = L.setLeafSize(state.tree, usableRect(), selected, k === 'W' ? 'x' : 'y', v + state.gap, minCell());
      if (!ok) {
        toast(`This tray spans the drawer's full ${k === 'W' ? 'width' : 'depth'}. Change the drawer size instead.`);
        renderInspector();
        return;
      }
      undoStack.push(snapshot); redoStack.length = 0;
      after();
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
      if (e.key === 'Enter' && e.target.matches('textarea') && !e.shiftKey) {
        // Enter saves the label and moves on to the next compartment
        e.preventDefault();
        const all = $$('#inspector [data-label]'), at = all.indexOf(e.target);
        const nextKey = at >= 0 && at < all.length - 1 ? all[at + 1].dataset.label : null;
        e.target.blur();
        const nx = nextKey && el.querySelector(`[data-label="${nextKey}"]`);
        if (nx) nx.focus();
      }
    });
  }

  function splitSel(dir, n) {
    if (!selected) return;
    commit(st => { const r = L.splitLeaf(st.tree, selected, dir, n); st.tree = r.root; if (r.ids.length) selected = r.ids[0]; });
  }
  function mergeSel(side) {
    if (!selected) return;
    const mo = L.mergeOptions(state.tree, selected);
    if (!mo.dir) return;
    const s = side || (mo.prev ? 'prev' : 'next');
    if ((s === 'prev' && !mo.prev) || (s === 'next' && !mo.next)) return;
    commit(st => { const r = L.mergeLeaf(st.tree, selected, s); st.tree = r.root; selected = r.keep; });
  }

  /* -------------------------------------------------------------- views */

  function setView(v) {
    view = v;
    for (const b of $$('.tabs button')) b.classList.toggle('on', b.dataset.view === v);
    for (const s of $$('.view')) s.classList.toggle('on', s.id === 'view-' + v);
    renderView();
  }

  function renderView() {
    if (view === 'sheets' && dirty.sheets) { renderSheets(); dirty.sheets = false; }
    if (view === 'list' && dirty.list) { renderList(); dirty.list = false; }
    if (view === '3d') render3D();
  }

  function renderAll() {
    renderLayout(); renderInspector(); renderStatus(); renderView();
  }

  function renderStatus() {
    const m = model, s = state.sheet;
    const sheetLabel = `${fmt(s.W)} × ${fmt(s.H)} ${state.units}`;
    const len = state.units === 'in' ? `${(m.cutLen / 304.8).toFixed(1)} ft` : `${(m.cutLen / 1000).toFixed(2)} m`;
    $('#status').innerHTML = `
      <span><b>${m.trays.length}</b> trays per set</span>
      <span><b>${m.types.length}</b> sizes</span>
      <span>× <b>${state.sets}</b> set${state.sets > 1 ? 's' : ''}</span>
      <span><b>${m.partCount}</b> parts</span>
      <span><b>${m.sheets.length}</b> sheet${m.sheets.length === 1 ? '' : 's'} of ${esc(sheetLabel)}</span>
      <span><b>${m.yieldPct.toFixed(0)}%</b> yield</span>
      <span>cut length <b>${len}</b></span>
      ${m.engravePending ? '<span>loading engraving font…</span>' : ''}
      ${m.warnings.length ? `<span class="w" id="warnLink">⚠ ${m.warnings.length} warning${m.warnings.length > 1 ? 's' : ''}</span>` : ''}`;
    const wl = $('#warnLink');
    if (wl) wl.onclick = () => setView('list');
  }

  const TYPE_FILLS = ['#6a432b', '#7a4e32', '#5d3a25', '#83573a', '#704630', '#5a3826'];

  function sheetSVG(sh, i) {
    const { w: W, h: H } = sh;
    const m = state.sheet.margin;
    let s = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Sheet ${i + 1}">
      <rect class="sheet-bg" width="${W}" height="${H}"/>`;
    for (let y = 9; y < H; y += 17) s += `<path d="M0 ${y} Q${W / 3} ${y - 2} ${W / 2} ${y + 1} T${W} ${y}" stroke="rgba(120,80,40,.12)" fill="none" stroke-width=".8"/>`;
    if (m > 0) s += `<rect class="sheet-margin" x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}"/>`;
    for (const si of sh.items) {
      const pl = X.placeItem(si);
      const d = [pl.outline, ...pl.holes].map(poly => 'M' + poly.map(p => `${p[0].toFixed(2)} ${(H - p[1]).toFixed(2)}`).join('L') + 'Z').join('');
      const ti = model.types.indexOf(si.item.up.type);
      s += `<path class="sheet-part" d="${d}" fill="${TYPE_FILLS[ti % TYPE_FILLS.length]}"/>`;
      if (pl.engrave && pl.engrave.length) s += `<path class="engr ${state.engrave.style}" d="${E.svgPathData(pl.engrave, y => H - y)}"/>`;
      const fs = clamp(Math.min(si.w, si.h) * 0.34, 3, 15);
      s += `<text class="sheet-label" x="${si.x + si.w / 2}" y="${H - (si.y + si.h / 2)}" font-size="${fs}">${si.item.up.type.letter}·${si.item.up.code}</text>`;
    }
    return s + '</svg>';
  }

  function renderSheets() {
    const m = model, s = state.sheet;
    const sheetArea = s.W * s.H;
    let html = `<div class="sheets-head">
      <h2>Cut sheets <em>${m.sheets.length}</em></h2>
      <p>${esc(fmt(s.W))} × ${esc(fmt(s.H))} ${state.units} stock, ${esc(fmtU(state.T))} thick · grain runs left to right · ${m.partCount} parts · ${m.yieldPct.toFixed(0)}% yield</p>
      <button class="chip no-print" onclick="window.print()">Print sheet map</button>
    </div>`;
    if (m.unplaced.length) html += `<div class="warnbox" style="margin-bottom:18px">${esc(m.warnings.find(w => /won't fit/.test(w)) || '')}</div>`;
    html += `<div class="sheet-grid">`;
    m.sheets.forEach((sh, i) => {
      const used = sh.items.reduce((a, si) => a + si.item.up.area, 0);
      html += `<article class="sheet-card" style="animation-delay:${Math.min(i, 8) * 0.04}s">
        <header><b>Sheet ${i + 1}</b><span>${sh.items.length} parts · ${((100 * used) / sheetArea).toFixed(0)}% used</span></header>
        ${sheetSVG(sh, i)}
        <div class="grain-arrow">grain ⟶</div>
      </article>`;
    });
    html += `</div>`;
    $('#sheets').innerHTML = html;
  }

  function renderList() {
    const m = model;
    const len = state.units === 'in' ? `${(m.cutLen / 304.8).toFixed(1)} ft` : `${(m.cutLen / 1000).toFixed(2)} m`;
    const total = m.trays.length * state.sets;
    let html = `<div class="doc">
      <h2>Cut list <em>&amp; assembly</em></h2>
      <div class="stats">
        <div><b>${total}</b><span>trays total</span></div>
        <div><b>${m.types.length}</b><span>tray sizes</span></div>
        <div><b>${m.partCount}</b><span>parts</span></div>
        <div><b>${m.sheets.length}</b><span>sheets</span></div>
        <div><b>${m.yieldPct.toFixed(0)}%</b><span>material yield</span></div>
        <div><b>${len}</b><span>cut length</span></div>
      </div>`;
    if (m.warnings.length) html += `<section><h3>Warnings</h3><ul class="warnlist">${m.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></section>`;
    html += `<section><h3>Trays</h3><table><thead><tr><th>Tray</th><th>Quantity</th><th>Outside W × D × H</th><th>Inside, above floor</th><th>Joinery</th></tr></thead><tbody>`;
    for (const ty of m.types) {
      const g = ty.geom, T = state.T;
      html += `<tr><td><span class="sw">${ty.letter}</span>Tray ${ty.letter}</td><td class="n">${ty.count * state.sets}</td>
        <td class="n">${esc(fmt(ty.a))} × ${esc(fmt(ty.b))} × ${esc(fmt(ty.H))}</td>
        <td class="n">${esc(fmt(ty.a - 2 * T))} × ${esc(fmt(ty.b - 2 * T))} × ${esc(fmt(ty.H - g.lift - T))}</td>
        <td class="n">${g.segments} fingers · ${g.tabsPerSide.x}/${g.tabsPerSide.y} tabs${ty.divs.x.length + ty.divs.y.length ? ` · ${ty.divs.x.length + 1}×${ty.divs.y.length + 1} compartments` : ''}${g.floorPieces > 1 ? ` · floor in ${g.floorPieces} pieces` : ''}</td></tr>`;
    }
    html += `</tbody></table></section>`;
    html += `<section><h3>Parts</h3><table><thead><tr><th>Part</th><th>Cut size (${state.units})</th><th>Quantity</th><th>Sheets</th><th>File</th></tr></thead><tbody>`;
    for (const up of m.uniqueParts) {
      html += `<tr><td><span class="sw">${up.type.letter}</span>${esc(up.name)}</td>
        <td class="n">${esc(fmt(up.cut.w))} × ${esc(fmt(up.cut.h))}</td><td class="n">${up.qty}</td>
        <td class="n">${Array.from(up.sheets).sort((a, b) => a - b).join(', ') || '–'}</td>
        <td class="n">${esc(partFile(up))}.dxf</td></tr>`;
    }
    html += `</tbody></table></section>`;
    html += `<section><h3>Assembly</h3><ol class="steps">
      <li>Dry-fit one tray before gluing any. If the joints are too tight or too loose, adjust the kerf setting and export again.</li>
      <li>Join two adjacent walls at the finger joint. Each corner pairs a wall with full fingers at its top and bottom corners with one that is notched there.</li>
      <li>If the floor comes in pieces, glue the puzzle keys and press the pieces together flat. Do this on a flat surface with wax paper under the seam. Seams that run under a divider have no keys: the divider's tabs lock those pieces together.</li>
      <li>Drop the floor in, with its tabs in the wall slots.</li>
      <li>If the tray has dividers, fit them now: bottom tabs go into the floor slots and end tabs into the wall slots. Where dividers cross, the one notched from below drops over the one notched from above.</li>
      <li>Engraved floors go in engraved face up. The slots only line up that way.</li>
      <li>Add the remaining two walls. Their slots slide over the floor and divider tabs.</li>
      <li>Glue the finger joints sparingly. The floor tabs lock the tray square, so the floor can go in dry.</li>
      <li>Sand the finger ends and tab ends flush with the outside faces.</li>
    </ol></section>
    <p class="no-print"><button class="chip" onclick="window.print()">Print cut list</button></p>
    </div>`;
    $('#cutlist').innerHTML = html;
  }

  /* ----------------------------------------------------------------- 3D */

  let viewerMounted = false;
  const boxCache = new Map();
  function threeData() {
    const prm = params(), pk = JSON.stringify(prm);
    if (boxCache.size > 300) boxCache.clear();
    return {
      drawer: state.drawer, T: state.T, explodeMax: state.T * 4 + 14, engraveStyle: state.engrave.style,
      trays: model.trays.map(t => {
        const ek = `${t.labels ? `${JSON.stringify(t.labels)}|${JSON.stringify(state.engrave)}|${fontStatus()}` : ''}|${JSON.stringify(floorMaxFor(t.W, t.D))}`;
        const key = `${t.W.toFixed(2)}|${t.D.toFixed(2)}|${t.H.toFixed(2)}|${t.divs.x.map(v => v.toFixed(2))}|${t.divs.y.map(v => v.toFixed(2))}|${pk}|${ek}`;
        let box = boxCache.get(key);
        if (!box) { box = trayBox(t.W, t.D, t.H, t.divs, t.labels, prm).box; boxCache.set(key, box); }
        return { key, x: t.x, y: t.y, W: t.W, D: t.D, H: t.H, parts: box.parts, selected: t.id === selected };
      }),
    };
  }
  function render3D() {
    if (!window.Viewer3D) return;
    const msg = $('#threeMsg');
    if (!viewerMounted) {
      try { window.Viewer3D.mount($('#three')); viewerMounted = true; }
      catch (e) { msg.textContent = '3D preview unavailable: WebGL could not start.'; return; }
    }
    msg.style.display = 'none';
    window.Viewer3D.resize();
    if (dirty.three) { window.Viewer3D.update(threeData()); dirty.three = false; }
  }
  window.addEventListener('viewer3d-ready', () => { if (view === '3d') render3D(); });
  setTimeout(() => { if (!window.Viewer3D) $('#threeMsg').textContent = 'The 3D preview needs an internet connection to load three.js. Everything else works offline.'; }, 9000);

  /* ------------------------------------------------------------- export */

  const pad2 = n => String(n).padStart(2, '0');
  const partFile = up => `${up.type.letter}-${up.slug}_qty${up.qty}`;

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function readme(stamp) {
    const s = state.sheet, du = state.exp.dxfUnits;
    const lines = [
      'FINGERPRINT: MANUFACTURING FILES',
      `Generated ${stamp}`,
      '',
      `Material:  ${fmtU(state.T)} thick. Check this against the supplier's measured thickness.`,
      `Kerf:      ${state.kerf ? fmtU(state.kerf) + ' compensation is built into the geometry.' : 'None applied. The parts are drawn at final size, so the cutting service must compensate for kerf.'}`,
      `Trays:     ${model.trays.length} per set × ${state.sets} set(s) = ${model.trays.length * state.sets} trays in ${model.types.length} size(s)`,
      `Sheets:    ${model.sheets.length} × ${fmt(s.W)} × ${fmt(s.H)} ${state.units}, grain along the ${fmt(s.W)} edge${s.allowRotate ? ' (rotation allowed, so grain is ignored)' : ''}`,
      '',
      'CONTENTS',
      '  sheets/       Nested layouts, one per sheet. SVG uses mm with pure-blue (#0000FF) cut lines.',
      `                The DXF files are AutoCAD R12 in ${du === 'in' ? 'inches' : 'millimetres'}.`,
      '  parts/        One file per unique part, with its quantity in the file name (..._qty12.dxf).',
      '                Each part is drawn with the grain running left to right.',
      '  cutlist.csv   Every unique part with its size, quantity and sheet numbers.',
      '  project.json  Open this in FingerPrint to edit the set.',
      '',
      'WHICH FILES TO SEND',
      `  Services that nest parts for you (SendCutSend, OSH Cut, etc.): upload parts/*.dxf.`,
      `      Enter each quantity from the file name and choose ${du === 'in' ? 'inches' : 'mm'} as the units.`,
      '  Ponoko: upload the SVGs (sheets/*.svg, or parts/*.svg if they nest for you). After upload, assign',
      '      the laser actions by color: blue stroke = cut, gray fill = area engrave, red stroke = line engrave.',
      '      Check their 2D proof. Engraved floors must go into the tray engraved face up.',
      '  Your own laser or a makerspace: use sheets/*.svg or sheets/*.dxf. Set the kerf in the app first (typically 0.15–0.2 mm).',
      '',
      `Engraving: ${model.types.some(ty => ty.labels) ? (state.engrave.style === 'line' ? 'line engrave, red (#FF0000) strokes' : 'area engrave, gray (#808080) filled text') + ' on the floors. Text is converted to outlines, so no fonts are needed. In DXF, engraving is on layer ENGRAVE (outlines only).' : 'none'}`,
      'In every file, engraving comes first, then inner cuts (slots), then outlines, so parts stay put',
      'until they are finished.',
      '',
      'ASSEMBLY',
      '  1. Dry-fit one tray first.',
      '  2. Join a long wall to an end wall at the finger joint.',
      '  3. Glue up any multi-piece floor first: glue the puzzle keys and press flat on wax paper.',
      '     Seams that run under a divider have no keys; the divider ties those pieces together.',
      '     Drop the floor in with its tabs in the slots. Fit any dividers: their bottom tabs go into',
      '     the floor slots and their end tabs into the wall slots. At crossings, the divider notched',
      '     from below drops over the one notched from above. Engraved floors go in engraved face up.',
      '     Then add the other two walls.',
      '  4. Glue the finger joints sparingly, then sand the joint and tab ends flush.',
    ];
    return lines.join('\n') + '\n';
  }

  async function exportZip() {
    if (!window.JSZip) { toast('The ZIP library did not load. Check your internet connection.'); return; }
    if (!model.sheets.length) { toast('Nothing to export yet.'); return; }
    if (model.engravePending) { toast('The engraving font is still loading. Try again in a moment.'); return; }
    const zip = new window.JSZip();
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
    const opts = { hairline: state.exp.hairline, engraveStyle: state.engrave.style };
    const du = state.exp.dxfUnits;
    model.sheets.forEach((sh, i) => {
      const shapes = sh.items.map(X.placeItem);
      const nm = `sheet-${pad2(i + 1)}`;
      zip.file(`sheets/${nm}.svg`, X.svgDoc(sh.w, sh.h, shapes, Object.assign({ title: `Sheet ${i + 1} of ${model.sheets.length}` }, opts)));
      zip.file(`sheets/${nm}.dxf`, X.dxfDoc(shapes, du));
    });
    for (const up of model.uniqueParts) {
      const w = up.grainRot === 90 ? up.cut.h : up.cut.w, h = up.grainRot === 90 ? up.cut.w : up.cut.h;
      const shape = X.placeItem({ item: { cut: up.cut }, x: 0, y: 0, rot: up.grainRot });
      zip.file(`parts/${partFile(up)}.dxf`, X.dxfDoc([shape], du));
      zip.file(`parts/${partFile(up)}.svg`, X.svgDoc(w, h, [shape], Object.assign({ title: `Tray ${up.type.letter} ${up.name} ×${up.qty}` }, opts)));
    }
    const cu = state.units;
    const rows = [['part', 'tray', 'tray_outside_W', 'tray_outside_D', 'tray_outside_H', 'cut_width', 'cut_height', 'units', 'quantity', 'sheets', 'file']];
    for (const up of model.uniqueParts) {
      const g = v => (cu === 'in' ? (v / IN).toFixed(4) : v.toFixed(2));
      rows.push([up.name, up.type.letter, g(up.type.a), g(up.type.b), g(up.type.H), g(up.cut.w), g(up.cut.h), cu, up.qty,
        Array.from(up.sheets).sort((a, b) => a - b).join(' '), partFile(up)]);
    }
    zip.file('cutlist.csv', X.csv(rows));
    zip.file('project.json', JSON.stringify(state, null, 1));
    zip.file('README.txt', readme(stamp));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    download(blob, `trays-${now.toISOString().slice(0, 10)}.zip`);
    toast(`Exported ${model.sheets.length} sheet(s) and ${model.uniqueParts.length} part files.`);
  }

  /* ------------------------------------------------------------- chrome */

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
  }

  function wireChrome() {
    $('#presetSel').innerHTML = PRESETS.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    for (const inp of $$('[data-bind]')) {
      inp.addEventListener('change', () => onBind(inp));
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') inp.blur();
        if (e.key === 'Escape') { inp.blur(); syncInputs(); }
      });
      inp.addEventListener('blur', () => setTimeout(syncInputs, 0));
    }
    for (const b of $$('#unitSeg button')) b.addEventListener('click', () => {
      if (state.units === b.dataset.u) return;
      state.units = b.dataset.u; persist(); syncInputs(); dirty.sheets = dirty.list = true; renderAll();
    });
    for (const b of $$('.tabs button')) b.addEventListener('click', () => setView(b.dataset.view));
    $('#undoBtn').addEventListener('click', undo);
    $('#redoBtn').addEventListener('click', redo);
    $('#exportBtn').addEventListener('click', () => exportZip().catch(e => toast('Export failed: ' + e.message)));
    $('#saveBtn').addEventListener('click', () => {
      download(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }), 'tray-project.json');
    });
    $('#openBtn').addEventListener('click', () => $('#fileOpen').click());
    $('#fileOpen').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        let next = null;
        try { next = fromJSON(JSON.parse(rd.result)); } catch (err) { next = null; }
        if (!next) { toast("That file isn't a FingerPrint project."); return; }
        pushHistory(); state = next; selected = null; after();
        toast('Project opened.');
      };
      rd.readAsText(f);
      e.target.value = '';
    });
    $('#gridBtn').addEventListener('click', () => {
      const c = parseInt($('#gridCols').value, 10), r = parseInt($('#gridRows').value, 10);
      if (!(c >= 1 && c <= 20 && r >= 1 && r <= 20)) { toast('Enter columns and rows from 1 to 20.'); return; }
      commit(st => { st.tree = L.grid(c, r); selected = null; });
    });
    $('#explode').addEventListener('input', e => { if (window.Viewer3D && viewerMounted) window.Viewer3D.setExplode(+e.target.value); });
    $('#resetView').addEventListener('click', () => window.Viewer3D && window.Viewer3D.resetView());

    document.addEventListener('keydown', e => {
      const typing = e.target.closest('input, select, textarea');
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
      if (typing || mod || e.altKey) return;
      if (['1', '2', '3', '4'].includes(e.key)) { setView(['layout', '3d', 'sheets', 'list'][+e.key - 1]); return; }
      if (view !== 'layout') return;
      const k = e.key.toLowerCase();
      if (k === 'escape') select(null);
      else if (k === 'c') splitSel('x', 2);
      else if (k === 'r') splitSel('y', 2);
      else if (k === 'backspace' || k === 'delete') { e.preventDefault(); mergeSel(); }
    });
  }

  /* --------------------------------------------------------------- boot */

  rebuild();
  wireChrome();
  wireLayout();
  wireInspector();
  syncInputs();
  renderAll();
})();
