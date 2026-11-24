// Mahjong solitaire solver. Pure logic, no DOM: loaded before frame.js in the
// game iframe, and usable from Node for testing (module.exports).
//
// Input: live tiles as {id, group, suit, left:[ids], right:[ids], above:[ids]}
// using the game's own neighbor lists, so "free" means exactly what the game
// means: nothing on top, and not boxed in on both the left and the right.
//
// Search: depth-first with
//   - forced "safe" moves (last 2 of a set both free, or all 4 of a set free)
//     taken without branching, since they can never hurt;
//   - a dead-state memo (Zobrist hash of the removed set);
//   - pruning when the last two tiles of a set sit one on top of the other;
//   - move ordering that prefers uncovering many tiles, then keeping a
//     same-suit streak going.
// It runs in slices (step(ms)) so the game stays responsive.
(function (root) {
  'use strict';

  function createSolve(tiles, opts) {
    opts = opts || {};
    const maxNodes = opts.maxNodes || 3e6;
    const N = tiles.length;
    const idx = new Map(tiles.map((t, i) => [t.id, i]));
    const toIdx = (ids) => Int32Array.from(ids.filter((id) => idx.has(id)).map((id) => idx.get(id)));
    const L = tiles.map((t) => toIdx(t.left));
    const R = tiles.map((t) => toIdx(t.right));
    const A = tiles.map((t) => toIdx(t.above));
    const gmap = new Map();
    const G = Int32Array.from(tiles.map((t) => (gmap.has(t.group) ? gmap.get(t.group) : gmap.set(t.group, gmap.size).get(t.group))));
    const NG = gmap.size;
    const suit = tiles.map((t) => t.suit);
    const members = Array.from({ length: NG }, () => []);
    G.forEach((g, i) => members[g].push(i));

    // Who depends on me: tiles that have me in their above / left / right list.
    const coversOf = Array.from({ length: N }, () => []); // I'm on top of these
    const sideOf = Array.from({ length: N }, () => []);
    for (let i = 0; i < N; i++) {
      for (const a of A[i]) coversOf[a].push(i);
      for (const s of L[i]) sideOf[s].push(i);
      for (const s of R[i]) sideOf[s].push(i);
    }
    // Transitive "must be removed before me" via above-links, as bitsets.
    const W = Math.ceil(N / 32);
    const over = Array.from({ length: N }, () => new Uint32Array(W));
    const has = (bs, j) => (bs[j >>> 5] >>> (j & 31)) & 1;
    // process tiles from the top layer down so above-sets are complete
    const order = [...Array(N).keys()].sort((a, b) => (tiles[b].layer || 0) - (tiles[a].layer || 0));
    const done = new Uint8Array(N);
    function closeOver(i) {
      if (done[i]) return over[i];
      done[i] = 1;
      const bs = over[i];
      for (const a of A[i]) {
        bs[a >>> 5] |= 1 << (a & 31);
        const sub = closeOver(a);
        for (let w = 0; w < W; w++) bs[w] |= sub[w];
      }
      return bs;
    }
    order.forEach(closeOver);
    const depth = over.map((bs) => { let c = 0; for (let w = 0; w < W; w++) { let x = bs[w]; while (x) { x &= x - 1; c++; } } return c; });
    // how many tiles sit (transitively) under me
    const under = new Int32Array(N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (has(over[j], i)) under[i]++;

    // Zobrist hashing (seeded so runs are repeatable).
    let seed = 0x9e3779b9;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const z1 = Uint32Array.from({ length: N }, rnd), z2 = Uint32Array.from({ length: N }, rnd);

    const rem = new Uint8Array(N);
    const left = new Int32Array(NG);
    G.forEach((g) => left[g]++);
    let h1 = 0, h2 = 0, removed = 0;

    function isFree(i) {
      if (rem[i]) return false;
      for (const a of A[i]) if (!rem[a]) return false;
      let l = false, r = false;
      for (const s of L[i]) if (!rem[s]) { l = true; break; }
      if (!l) return true;
      for (const s of R[i]) if (!rem[s]) { r = true; break; }
      return !r;
    }
    function apply(m) { for (const i of m) { rem[i] = 1; h1 ^= z1[i]; h2 ^= z2[i]; left[G[i]]--; removed++; } }
    function undo(m) { for (const i of m) { rem[i] = 0; h1 ^= z1[i]; h2 ^= z2[i]; left[G[i]]++; removed--; } }

    // Last two of a set where one is (transitively) on top of the other: dead.
    // Same idea for the last four: some way to split them into two pairs must
    // exist where neither pair is stacked inside itself and the pairs don't
    // each need the other gone first.
    const above2 = (x, y) => has(over[y], x); // x is (transitively) on top of y
    const comparable = (x, y) => above2(x, y) || above2(y, x);
    function groupDead(g) {
      if (left[g] !== 2 && left[g] !== 4) return false;
      const r = [];
      for (const i of members[g]) if (!rem[i]) r.push(i);
      if (r.length === 2) return comparable(r[0], r[1]);
      const [a, b, c, d] = r;
      const ok = (p, q, s, t) => {
        if (comparable(p, q) || comparable(s, t)) return false;
        const pFirst = above2(s, p) || above2(s, q) || above2(t, p) || above2(t, q); // pair2 must go before pair1
        const sFirst = above2(p, s) || above2(p, t) || above2(q, s) || above2(q, t);
        return !(pFirst && sFirst);
      };
      return !(ok(a, b, c, d) || ok(a, c, b, d) || ok(a, d, b, c));
    }

    // Restarts: a depth-first search can sink into a hopeless early choice. Each
    // run gets a node budget; when it runs out we start over from the top with
    // slightly shuffled move order, keeping every dead position already proven.
    let noise = 0, run = 0, runNodes = 0, runLimit = opts.restartNodes || 30000;
    // Sets down to their last two tiles must each be matched in one go. If set X
    // has a tile sitting on a tile of set Y, X has to go before Y. A loop of
    // such "before" links (X before Y before ... before X) can never be played.
    const rem2 = (g) => { const r = []; for (const i of members[g]) if (!rem[i]) r.push(i); return r; };
    function before(X, Y) { // some tile of X is on top of some tile of Y
      for (const x of X) for (const y of Y) if (above2(x, y)) return true;
      return false;
    }
    function loopThrough(g0) {
      const T = new Map();
      for (let g = 0; g < NG; g++) if (left[g] === 2) T.set(g, rem2(g));
      if (!T.has(g0)) return false;
      const seen = new Set([g0]);
      const todo = [g0];
      while (todo.length) {
        const X = T.get(todo.pop());
        for (const [g, Y] of T) {
          if (!before(X, Y)) continue;
          if (g === g0) return true;
          if (!seen.has(g)) { seen.add(g); todo.push(g); }
        }
      }
      return false;
    }

    function value(i, lastSuit) {
      let v = noise ? rnd() / 4294967296 * noise : 0;
      for (const c of coversOf[i]) if (!rem[c]) v += 4;
      for (const c of sideOf[i]) if (!rem[c]) v += 1;
      v += under[i] * 0.5 + depth[i] * 0.1;
      if (suit[i] === lastSuit) v += 0.75;
      return v;
    }

    function genMoves(lastSuit) {
      const free = Array.from({ length: NG }, () => null);
      for (let i = 0; i < N; i++) if (isFree(i)) (free[G[i]] || (free[G[i]] = [])).push(i);
      // safe moves first, no branching
      for (let g = 0; g < NG; g++) {
        const f = free[g];
        if (!f) continue;
        if (left[g] === 2 && f.length === 2) return [f];
        if (left[g] === 4 && f.length === 4) return [f];
      }
      const moves = [];
      for (let g = 0; g < NG; g++) {
        const f = free[g];
        if (!f || f.length < 2) continue;
        for (let a = 0; a < f.length; a++) for (let b = a + 1; b < f.length; b++) {
          const m = [f[a], f[b]];
          m.score = value(f[a], lastSuit) + value(f[b], lastSuit);
          moves.push(m);
        }
      }
      moves.sort((x, y) => y.score - x.score);
      return moves;
    }

    const dead = new Set();
    const stack = []; // frames {moves, k, applied, key}
    let nodes = 0, result = null;
    const t0 = Date.now();

    function enter() {
      // returns true if a new frame was pushed
      nodes++; runNodes++;
      if (removed === N) {
        result = { status: 'win', path: stack.map((f) => f.applied), nodes };
        return false;
      }
      const key = h1 * 2097152 + (h2 & 0x1fffff); // 53-bit numeric key, cheaper than strings
      if (dead.has(key)) return false;
      const top = stack.length ? stack[stack.length - 1].applied : null;
      if (top && (groupDead(G[top[0]]) || (left[G[top[0]]] === 2 && loopThrough(G[top[0]])))) { dead.add(key); return false; }
      const moves = genMoves(top ? suit[top[0]] : opts.lastSuit);
      if (!moves.length) { dead.add(key); return false; }
      stack.push({ moves, k: 0, applied: null, key });
      return true;
    }

    // root checks
    for (let g = 0; g < NG; g++) if (groupDead(g)) result = { status: 'lose', nodes: 0, reason: 'tiles of one set are stacked so they can never pair up' };
    for (let g = 0; g < NG && !result; g++) if (left[g] === 2 && loopThrough(g)) result = { status: 'lose', nodes: 0, reason: 'two sets are stacked so each needs the other cleared first' };
    let started = false;

    function restart() {
      while (stack.length) { const f = stack.pop(); if (f.applied) undo(f.applied); }
      run++; runNodes = 0; runLimit = Math.round(runLimit * 1.4); noise = opts.noise || 10;
      if (!enter() && !result) result = { status: 'lose', nodes };
    }

    function step(ms) {
      if (result) return result;
      const end = Date.now() + (ms || 20);
      if (!started) { started = true; if (!enter() && !result) result = { status: 'lose', nodes }; }
      while (!result) {
        if (!stack.length) { result = { status: 'lose', nodes }; break; }
        const f = stack[stack.length - 1];
        if (f.applied) { undo(f.applied); f.applied = null; }
        if (f.k >= f.moves.length) { dead.add(f.key); stack.pop(); continue; }
        const m = f.moves[f.k++];
        apply(m);
        f.applied = m;
        enter();
        if (nodes >= maxNodes || dead.size > (opts.maxDead || 8e6)) { result = { status: 'unknown', nodes }; break; }
        if (runNodes > runLimit && !result) restart();
        if ((nodes & 255) === 0 && Date.now() > end) break;
      }
      if (result) {
        result.ms = Date.now() - t0;
        if (result.path) {
          // flatten 4-tile safe moves into two pairs, map back to tile ids
          const pairs = [];
          for (const m of result.path) for (let i = 0; i < m.length; i += 2) pairs.push([tiles[m[i]].id, tiles[m[i + 1]].id]);
          result.path = pairs;
        }
      }
      if (result) result.runs = run + 1;
      return result || { status: 'solving', nodes, runs: run + 1 };
    }

    return { step };
  }

  const api = { createSolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__mjsbSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
