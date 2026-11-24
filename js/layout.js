/*
 * Drawer layout as a guillotine tree. A node is either
 *   { id, kind: 'leaf', h?: heightOverrideMm }
 *   { id, kind: 'split', dir: 'x' | 'y', children: [...], weights: [...] }
 * 'x' splits lay children out left→right (columns), 'y' top→bottom (rows).
 * Weights are relative so the layout scales when the drawer size changes.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.Layout = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  let counter = 0;
  function nid() { counter++; return 'n' + Date.now().toString(36).slice(-4) + counter.toString(36) + Math.random().toString(36).slice(2, 5); }
  function leaf(extra) { return Object.assign({ id: nid(), kind: 'leaf' }, extra || {}); }
  function split(dir, children, weights) {
    return { id: nid(), kind: 'split', dir, children, weights: weights || children.map(() => 1) };
  }
  const sum = a => a.reduce((s, x) => s + x, 0);
  const clone = t => JSON.parse(JSON.stringify(t));

  /** Rectangles for every node, plus the draggable dividers. */
  function compute(rootNode, rect) {
    const leaves = [], dividers = [], rects = new Map();
    (function rec(node, r) {
      rects.set(node.id, r);
      if (node.kind === 'leaf') { leaves.push({ node, rect: r }); return; }
      const total = sum(node.weights);
      const L = node.dir === 'x' ? r.w : r.h;
      let off = 0;
      node.children.forEach((c, i) => {
        const s = (L * node.weights[i]) / total;
        const cr = node.dir === 'x' ? { x: r.x + off, y: r.y, w: s, h: r.h } : { x: r.x, y: r.y + off, w: r.w, h: s };
        rec(c, cr);
        off += s;
        if (i < node.children.length - 1) {
          dividers.push({ splitId: node.id, index: i, dir: node.dir, pos: (node.dir === 'x' ? r.x : r.y) + off, rect: r });
        }
      });
    })(rootNode, rect);
    return { leaves, dividers, rects };
  }

  /** Path of nodes from the root to the node with this id (inclusive). */
  function findPath(rootNode, id) {
    const path = [];
    (function rec(node) {
      path.push(node);
      if (node.id === id) return true;
      if (node.kind === 'split') for (const c of node.children) if (rec(c)) return true;
      path.pop();
      return false;
    })(rootNode);
    return path.length ? path : null;
  }

  function findNode(rootNode, id) { const p = findPath(rootNode, id); return p ? p[p.length - 1] : null; }

  /** Collapse single-child splits and flatten nested splits of the same direction. */
  function normalize(node) {
    if (node.kind === 'leaf') return node;
    node.children = node.children.map(normalize);
    const kids = [], ws = [];
    node.children.forEach((c, i) => {
      const w = node.weights[i];
      if (c.kind === 'split' && c.dir === node.dir) {
        const t = sum(c.weights);
        c.children.forEach((cc, j) => { kids.push(cc); ws.push((w * c.weights[j]) / t); });
      } else { kids.push(c); ws.push(w); }
    });
    node.children = kids; node.weights = ws;
    if (node.children.length === 1) return node.children[0];
    return node;
  }

  /** Split a leaf into n equal parts along dir. Returns { root, ids }. */
  function splitLeaf(rootNode, id, dir, n) {
    const path = findPath(rootNode, id);
    if (!path) return { root: rootNode, ids: [] };
    const target = path[path.length - 1], parent = path[path.length - 2];
    if (target.kind !== 'leaf') return { root: rootNode, ids: [] };
    const fresh = Array.from({ length: n }, () => leaf(target.h ? { h: target.h } : {}));
    if (parent && parent.dir === dir) {
      const i = parent.children.indexOf(target), w = parent.weights[i];
      parent.children.splice(i, 1, ...fresh);
      parent.weights.splice(i, 1, ...fresh.map(() => w / n));
      return { root: rootNode, ids: fresh.map(f => f.id) };
    }
    const s = split(dir, fresh);
    if (!parent) return { root: s, ids: fresh.map(f => f.id) };
    parent.children[parent.children.indexOf(target)] = s;
    return { root: rootNode, ids: fresh.map(f => f.id) };
  }

  /**
   * Which neighbour (if any) a leaf can merge into. side: 'prev' | 'next'
   * along its parent's direction. Returns the parent's direction too.
   */
  function mergeOptions(rootNode, id) {
    const path = findPath(rootNode, id);
    if (!path || path.length < 2) return { dir: null, prev: false, next: false };
    const parent = path[path.length - 2], i = parent.children.indexOf(path[path.length - 1]);
    return { dir: parent.dir, prev: i > 0, next: i < parent.children.length - 1 };
  }

  /** Remove a leaf and give its space to the neighbour on `side`. */
  function mergeLeaf(rootNode, id, side) {
    const path = findPath(rootNode, id);
    if (!path || path.length < 2) return { root: rootNode, keep: id };
    const parent = path[path.length - 2], i = parent.children.indexOf(path[path.length - 1]);
    const j = side === 'prev' ? i - 1 : i + 1;
    if (j < 0 || j >= parent.children.length) return { root: rootNode, keep: id };
    parent.weights[j] += parent.weights[i];
    const neighbour = parent.children[j];
    parent.children.splice(i, 1); parent.weights.splice(i, 1);
    const newRoot = normalize(rootNode);
    let keep = neighbour;
    while (keep.kind === 'split') keep = keep.children[side === 'prev' ? keep.children.length - 1 : 0];
    return { root: newRoot, keep: keep.id };
  }

  /** Replace a leaf's whole parent group with a single leaf. */
  function collapseParent(rootNode, id) {
    const path = findPath(rootNode, id);
    if (!path || path.length < 2) return { root: rootNode, keep: id };
    const parent = path[path.length - 2], grand = path[path.length - 3];
    const me = path[path.length - 1];
    const fresh = leaf(me.h ? { h: me.h } : {});
    if (!grand) return { root: fresh, keep: fresh.id };
    grand.children[grand.children.indexOf(parent)] = fresh;
    return { root: normalize(rootNode), keep: fresh.id };
  }

  function childSizes(node, r) {
    const L = node.dir === 'x' ? r.w : r.h, t = sum(node.weights);
    return node.weights.map(w => (L * w) / t);
  }
  function setSizes(node, sizes) {
    const t = sum(sizes);
    node.weights = sizes.map(s => s / t);
  }

  /** Move divider `index` of split `splitId` to absolute position pos. */
  function moveDivider(rootNode, rect, splitId, index, pos, minSize) {
    const { rects } = compute(rootNode, rect);
    const node = findNode(rootNode, splitId);
    if (!node || node.kind !== 'split') return false;
    const r = rects.get(splitId), sizes = childSizes(node, r);
    const start = (node.dir === 'x' ? r.x : r.y) + sum(sizes.slice(0, index));
    const pair = sizes[index] + sizes[index + 1];
    const min = Math.min(minSize, pair / 2);
    const a = Math.max(min, Math.min(pair - min, pos - start));
    sizes[index] = a; sizes[index + 1] = pair - a;
    setSizes(node, sizes);
    return true;
  }

  /**
   * Set the cell size of a leaf along dir (mm), taking/giving the difference
   * from the adjacent sibling at the nearest ancestor split in that direction.
   */
  function setLeafSize(rootNode, rect, id, dir, size, minSize) {
    const path = findPath(rootNode, id);
    if (!path) return false;
    const { rects } = compute(rootNode, rect);
    for (let k = path.length - 2; k >= 0; k--) {
      const node = path[k];
      if (node.kind !== 'split' || node.dir !== dir) continue;
      const i = node.children.indexOf(path[k + 1]);
      const j = i + 1 < node.children.length ? i + 1 : i - 1;
      if (j < 0) return false;
      const sizes = childSizes(node, rects.get(node.id));
      const pair = sizes[i] + sizes[j];
      const min = Math.min(minSize, pair / 2);
      sizes[i] = Math.max(min, Math.min(pair - min, size));
      sizes[j] = pair - sizes[i];
      setSizes(node, sizes);
      return true;
    }
    return false;
  }

  /** Uniform grid helper. */
  function grid(cols, rows) {
    const col = () => (rows > 1 ? split('y', Array.from({ length: rows }, () => leaf())) : leaf());
    return cols > 1 ? split('x', Array.from({ length: cols }, col)) : col();
  }

  return { leaf, split, clone, compute, findPath, findNode, normalize, splitLeaf, mergeOptions, mergeLeaf, collapseParent, moveDivider, setLeafSize, grid };
});
