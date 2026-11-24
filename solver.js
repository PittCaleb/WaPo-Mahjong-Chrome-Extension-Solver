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

    // ---------- score optimizer ----------
    // Game scoring: each match scores 2 * suitValue * tilesLeftBeforeMatch * chain,
    // where chain grows by 1 for each back-to-back match of the same suit.
    const SV = opts.suitValue || [2, 3, 1, 4, 5, 6, 7];
    const flat = (moves) => { const p = []; for (const m of moves) for (let i = 0; i < m.length; i += 2) p.push([m[i], m[i + 1]]); return p; };
    const keyNow = () => h1 * 2097152 + (h2 & 0x1fffff);
    function scorePairs(pairs) {
      let last = opts.lastSuit ?? null, chain = opts.chain || 0, l = N, pts = 0;
      for (const [a] of pairs) { const su = suit[a]; chain = su === last ? chain + 1 : 1; last = su; pts += 2 * SV[su] * l * chain; l -= 2; }
      return pts;
    }

    // Bounded depth-first search from the current position. Leaves the board as
    // it found it. Dead positions it proves are kept (they're facts).
    function probe(budget, justMoved) {
      const fr = [];
      let n = 0, won = false;
      const push = (top) => {
        n++;
        if (removed === N) { won = true; return false; }
        const key = keyNow();
        if (dead.has(key)) return false;
        if (top && (groupDead(G[top[0]]) || (left[G[top[0]]] === 2 && loopThrough(G[top[0]])))) { dead.add(key); return false; }
        const moves = genMoves(null);
        if (!moves.length) { dead.add(key); return false; }
        fr.push({ moves, k: 0, applied: null, key });
        return true;
      };
      const unwind = () => { for (let i = fr.length - 1; i >= 0; i--) if (fr[i].applied) { undo(fr[i].applied); fr[i].applied = null; } };
      if (!push(justMoved)) return won ? { status: 'win', moves: [] } : { status: 'lose' };
      for (;;) {
        if (!fr.length) return { status: 'lose' };
        const f = fr[fr.length - 1];
        if (f.applied) { undo(f.applied); f.applied = null; }
        if (f.k >= f.moves.length) { dead.add(f.key); fr.pop(); continue; }
        const m = f.moves[f.k++];
        apply(m); f.applied = m;
        push(m);
        if (won) { const moves = fr.map((x) => x.applied); unwind(); return { status: 'win', moves }; }
        if (n > budget) { unwind(); return { status: 'unknown' }; }
      }
    }

    function freePairs() {
      const free = new Map();
      for (let i = 0; i < N; i++) if (isFree(i)) { const g = G[i]; (free.get(g) || free.set(g, []).get(g)).push(i); }
      const out = [];
      for (const f of free.values()) for (let a = 0; a < f.length; a++) for (let b = a + 1; b < f.length; b++) out.push([f[a], f[b]]);
      return out;
    }
    // Points now, plus how far the streak could run from here: keep taking free
    // pairs of the same suit (greedily) and add up what they'd score.
    function rate(m, last, chain, jitter) {
      const su = suit[m[0]], l = N - removed;
      let cn = su === last ? chain + 1 : 1;
      let v = 2 * SV[su] * l * cn;
      const done = [m];
      apply(m);
      const look = opts.lookahead ?? 0; // tested: looking further ahead scored worse
      for (let k = 1; k <= look; k++) {
        let nxt = null;
        for (const p of freePairs()) if (suit[p[0]] === su) { nxt = p; break; }
        if (!nxt) break;
        apply(nxt); done.push(nxt);
        v += 2 * SV[su] * (l - 2 * k) * (cn + k);
      }
      for (let i = done.length - 1; i >= 0; i--) undo(done[i]);
      return jitter ? v * (1 + jitter * rnd() / 4294967296) : v;
    }
    const same = (x, y) => x && y && ((x[0] === y[0] && x[1] === y[1]) || (x[0] === y[1] && x[1] === y[0]));

    // Build winning lines greedily by points, only taking a move when a win is
    // still provably reachable after it (otherwise follow a known winning line).
    // Repeat with some randomness and keep the best total. Yields to stay responsive.
    function* optimize(base) {
      const optMs = opts.optimizeMs ?? 5000, K = opts.optimizeTries || 12, PB = opts.probeNodes || 4000;
      const tStart = Date.now();
      let best = { pairs: base, pts: scorePairs(base) };
      const basePts = best.pts;
      for (let it = 0; Date.now() - tStart < optMs && it < (opts.optimizeIters || 200); it++) {
        const jitter = it === 0 ? 0 : (opts.jitter ?? 0.5);
        // After the first pass, keep the best line up to a random point and
        // rebuild only the rest (search near the best line found so far).
        const cut = it === 0 || opts.keepPrefix === false ? 0 : Math.floor(rnd() / 4294967296 * best.pairs.length);
        let wit = best.pairs.slice(cut);
        const made = best.pairs.slice(0, cut);
        let last = opts.lastSuit ?? null, chain = opts.chain || 0;
        for (const m of made) { apply(m); const su = suit[m[0]]; chain = su === last ? chain + 1 : 1; last = su; }
        while (removed < N) {
          const cands = freePairs().map((m) => (m.r = rate(m, last, chain, jitter), m)).sort((x, y) => y.r - x.r);
          let pick = null;
          if (Date.now() - tStart < optMs) {
            for (const c of cands.slice(0, K)) {
              if (same(c, wit[0])) { pick = c; wit = wit.slice(1); break; }
              apply(c);
              const r = probe(PB, c);
              undo(c);
              if (r.status === 'win') { pick = c; wit = flat(r.moves); break; }
              yield;
            }
          }
          if (!pick) { pick = wit[0]; wit = wit.slice(1); }
          apply(pick); made.push(pick);
          const su = suit[pick[0]]; chain = su === last ? chain + 1 : 1; last = su;
        }
        for (let i = made.length - 1; i >= 0; i--) undo(made[i]);
        const pts = scorePairs(made);
        if (pts > best.pts) best = { pairs: made, pts };
        yield;
      }
      return { pairs: best.pairs, pts: best.pts, basePts };
    }

    let gen = null, phase = 'search';

    function finish() {
      result.ms = Date.now() - t0;
      if (result.path) result.path = result.path.map(([a, b]) => [tiles[a].id, tiles[b].id]);
      result.runs = run + 1;
      return result;
    }

    function step(ms) {
      if (result && !gen) return result.ms === undefined ? finish() : result;
      const end = Date.now() + (ms || 20);
      if (gen) {
        while (Date.now() < end) {
          const r = gen.next();
          if (r.done) {
            gen = null;
            result.path = r.value.pairs; result.score = r.value.pts; result.baseScore = r.value.basePts;
            return finish();
          }
        }
        return { status: 'solving', phase, nodes };
      }
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
      if (!result) return { status: 'solving', phase, nodes, runs: run + 1 };
      if (result.path) {
        // back to the start position, as pairs of tile indexes
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].applied) { undo(stack[i].applied); stack[i].applied = null; }
        stack.length = 0;
        result.path = flat(result.path);
        if (opts.optimize) { gen = optimize(result.path); phase = 'optimize'; return { status: 'solving', phase, nodes }; }
        result.score = scorePairs(result.path);
      }
      return finish();
    }

    return { step };
  }

  const api = { createSolve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__mjsbSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
