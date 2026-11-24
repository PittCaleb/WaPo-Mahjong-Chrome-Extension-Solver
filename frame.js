// Runs inside the Arkadium game iframe (page's MAIN world) so it can read the
// live Phaser game. It never changes game state; it only reads the board,
// optionally tints tile sprites, and posts a snapshot to the parent page.
(() => {
  'use strict';
  const TAG = 'mjsb';
  const VERSION = '1.5.0';
  const TOP_ORIGIN = 'https://games.washingtonpost.com';
  const POLL_MS = 200;

  // Tile constants from the game bundle (Release-40).
  const TYPE_SUIT_MATCH = 2; // overwritten below if the game exposes it
  const SUIT_NAMES = ['Dots', 'Bamboo', 'Characters', 'Wind', 'Dragon', 'Flower', 'Season'];
  const SUIT_SHORT = ['●', 'B', 'C', 'Wd', 'Dr', 'Fl', 'Se'];
  const TINT = { solve: 0xb36bff, plan: 0x7fd0ff, match: 0x7dff8a, danger: 0xff7a7a, twin: 0xffb3b3, none: 0xffffff };

  let opts = { tint: true, danger: true };
  let manualFocusId = null;
  let lastGameSelectedId = null;
  let lastSig = '';
  let lastBoard = null;
  const tinted = new Map(); // tile id -> view we tinted
  const faceImg = {}; // face key -> dataURL | null
  let imagesSent = 0;

  const game = () => window.__arenax_v1__?.MahjongGame?.game?.game || null;

  // The board model (has `_tiles` of tile objects with Layer/Col/Row) and the
  // board view (has `_tileModelToView`) live somewhere under the current
  // Phaser state; search a few levels deep and cache what we find.
  let cached = null;
  const isBoard = (o) => o && Array.isArray(o._tiles) && o._tiles.length > 0 && 'Layer' in o._tiles[0];
  const isView = (o) => o && o._tileModelToView && typeof o._tileModelToView === 'object';

  function findIn(root, test, maxDepth) {
    const seen = new Set();
    let frontier = [root];
    for (let d = 0; d <= maxDepth && frontier.length; d++) {
      const next = [];
      for (const o of frontier) {
        if (!o || typeof o !== 'object' || seen.has(o)) continue;
        seen.add(o);
        if (test(o)) return o;
        if (o === window || o instanceof Node) continue;
        for (const k of Object.keys(o)) {
          if (k === 'game' || k === '_gameRef' || k === 'parent' || k === 'children') continue;
          const v = o[k];
          if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) next.push(v);
        }
      }
      frontier = next;
    }
    return null;
  }

  function scene() {
    const g = game();
    const cur = g?.state?.getCurrentState?.();
    if (!cur || g.state.current !== 'GameScene') { cached = null; return null; }
    // Board object is replaced on New Game; reuse the cache only while the
    // owner still points at the same board and the view still exists.
    if (cached && cached.state === cur && cached.owner._board === cached._board &&
        (!cached._boardView || cached._boardView._tileModelToView)) return cached;
    const board = findIn(cur, isBoard, 4);
    if (!board) return null;
    const view = findIn(cur, isView, 4);
    // owner = object holding `_board`, so we can detect replacement cheaply
    const owner = findIn(cur, (o) => o._board === board, 3) || cur;
    cached = { state: cur, owner, _board: board, _boardView: view };
    return cached;
  }

  function debugInfo() {
    const g = game();
    const cur = g?.state?.getCurrentState?.();
    const keys = cur ? Object.keys(cur).filter((k) => k.startsWith('_') || /board|controller|manager/i.test(k)) : null;
    const sc = scene();
    return {
      hasGame: !!g, current: g?.state?.current, stateKeys: keys,
      found: !!sc, tiles: sc ? sc._board._tiles.length : 0, view: !!(sc && sc._boardView),
    };
  }

  const letter = (v) => 'abcdefghijklm'[v];
  const faceKey = (t) => 'icon-' + (t.Suit + 1) + letter(t.Value);
  const faceLabel = (t) => {
    if (t.Suit === 5 || t.Suit === 6) return SUIT_SHORT[t.Suit] + (t.Value + 1);
    if (t.Suit === 3 || t.Suit === 4) return SUIT_SHORT[t.Suit] + (t.Value + 1);
    return SUIT_SHORT[t.Suit] + (t.Value + 1);
  };

  // Same rule as the game's doTilesMatch.
  function tilesMatch(a, b) {
    return a !== b && a.Suit === b.Suit &&
      ((a.Type === TYPE_SUIT_MATCH && b.Type === TYPE_SUIT_MATCH) || a.Value === b.Value) &&
      a.Type === b.Type;
  }

  // Footprint overlap: tiles occupy 2x2 half-cells starting at (Col, Row).
  const overlaps = (a, b) => Math.abs(a.Col - b.Col) < 2 && Math.abs(a.Row - b.Row) < 2;

  function extractFace(g, key) {
    if (key in faceImg) return;
    faceImg[key] = null;
    try {
      const fr = g.cache.getFrameByName('gameobjects', key + '.png');
      const img = g.cache.getImage('gameobjects');
      if (!fr || !img || fr.rotated) return;
      const sw = fr.sourceSizeW || fr.width, sh = fr.sourceSizeH || fr.height;
      const scale = Math.min(1, 72 / Math.max(sw, sh));
      const cv = document.createElement('canvas');
      cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
      const ctx = cv.getContext('2d');
      const dx = fr.trimmed ? fr.spriteSourceSizeX : 0, dy = fr.trimmed ? fr.spriteSourceSizeY : 0;
      ctx.drawImage(img, fr.x, fr.y, fr.width, fr.height, dx * scale, dy * scale, fr.width * scale, fr.height * scale);
      faceImg[key] = cv.toDataURL('image/png');
    } catch (e) { /* fall back to text labels */ }
  }

  function analyse(board) {
    const all = board._tiles;
    const live = all.filter((t) => t.IsInBoard);

    // Group tiles into match sets (4 normally; flowers/seasons match by suit).
    const groupOf = new Map();
    const reps = [];
    for (const t of all) {
      let gi = reps.findIndex((r) => r === t || tilesMatch(r, t));
      if (gi < 0) { gi = reps.length; reps.push(t); }
      groupOf.set(t, gi);
    }

    // Transitive "below" sets among live tiles (everything that can only be
    // reached after this tile is gone), processed bottom layer first.
    const byLayerAsc = [...live].sort((a, b) => a.Layer - b.Layer);
    const below = new Map();
    const aboveCount = new Map();
    for (const t of live) aboveCount.set(t, 0);
    for (const t of byLayerAsc) {
      const s = new Set();
      for (const u of byLayerAsc) {
        if (u.Layer >= t.Layer) break;
        if (overlaps(t, u)) { s.add(u); for (const w of below.get(u)) s.add(w); }
      }
      below.set(t, s);
      for (const u of s) aboveCount.set(u, aboveCount.get(u) + 1);
    }

    // Danger: a live tile with a matching live tile somewhere beneath it.
    const danger = new Set(), twin = new Set();
    const dangerPairs = [];
    if (opts.danger) {
      for (const t of live) {
        for (const u of below.get(t)) {
          if (groupOf.get(u) === groupOf.get(t)) {
            danger.add(t); twin.add(u);
            dangerPairs.push([t.ID, u.ID]);
          }
        }
      }
    }

    // Focus: the tile selected in the game wins; otherwise a shadow-board click.
    const sel = board._tileSelected || null;
    const selId = sel ? sel.ID : null;
    if (selId !== lastGameSelectedId) {
      lastGameSelectedId = selId;
      if (selId !== null) manualFocusId = null;
    }
    const focusId = selId !== null ? selId : manualFocusId;
    const focus = focusId !== null ? all.find((t) => t.ID === focusId) : null;
    const matchIds = new Set();
    if (focus) for (const t of live) if (t !== focus && groupOf.get(t) === groupOf.get(focus)) matchIds.add(t.ID);

    // Free pairs currently available.
    const free = live.filter((t) => !t.IsBlocked);
    let freePairs = 0;
    const seen = new Map();
    for (const t of free) { const gi = groupOf.get(t); seen.set(gi, (seen.get(gi) || 0) + 1); }
    for (const n of seen.values()) freePairs += Math.floor(n / 2);

    return { all, live, groupOf, aboveCount, danger, twin, dangerPairs, focus, focusSource: selId !== null ? 'game' : (focus ? 'shadow' : null), matchIds, freePairs };
  }

  // ---------- streak planner ----------
  // Game scoring (Release-40 MatchScorer): each match scores
  //   2 * suitValue * tilesLeftBeforeMatch * chain
  // where chain goes 1,2,3... while consecutive matches share a suit.
  const SUIT_VALUE = [2, 3, 1, 4, 5, 6, 7]; // by Suit id: Dots, Bamboo, Characters, Wind, Dragon, Flower, Season
  const NODE_CAP = 4000;
  let planKey = '', planCache = null;
  let planSuit = null; // suit picked in the panel, highlighted on the real board

  function streakState(board) {
    const ms = board._matchScorer;
    if (!ms) return { suit: null, chain: 0 };
    return { suit: ms._lastSuitMatched ?? null, chain: ms._chainMultiplier || 0 };
  }

  const streakPoints = (suit, n, left, c0) => {
    let p = 0;
    for (let k = 0; k < n; k++) p += 2 * SUIT_VALUE[suit] * (left - 2 * k) * (c0 + k);
    return p;
  };

  // Longest run of same-suit matches playable back to back, looking ahead as
  // each removed pair frees up the tiles next to / under it.
  function planSuitRun(live, suit, groupOf, useNeighbors) {
    const removed = new Set();
    const inBoard = (t) => t.IsInBoard && !removed.has(t);
    const isFree = useNeighbors
      ? (t) => {
          const l = t.NeighborsLeft.some(inBoard), r = t.NeighborsRight.some(inBoard);
          return !(l && r) && !t.NeighborsAbove.some(inBoard);
        }
      : (t) => !t.IsBlocked;
    const mine = live.filter((t) => t.Suit === suit);
    let best = [], nodes = 0;
    const path = [];
    (function dfs() {
      if (++nodes > NODE_CAP) return;
      if (path.length > best.length) best = path.slice();
      if (best.length * 2 >= mine.length) return; // can't do better
      const byGroup = new Map();
      for (const t of mine) {
        if (!inBoard(t) || !isFree(t)) continue;
        const g = groupOf.get(t);
        (byGroup.get(g) || byGroup.set(g, []).get(g)).push(t);
      }
      const cands = [];
      for (const ts of byGroup.values()) {
        for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) cands.push([ts[i], ts[j]]);
      }
      if (!useNeighbors && path.length) return; // no lookahead without neighbor data
      for (const [x, y] of cands) {
        removed.add(x); removed.add(y); path.push([x.ID, y.ID]);
        dfs();
        path.pop(); removed.delete(x); removed.delete(y);
        if (nodes > NODE_CAP || best.length * 2 >= mine.length) return;
      }
    })();
    return best;
  }

  function plan(board, a) {
    const st = streakState(board);
    const key = a.live.map((t) => t.ID + '@' + t.Layer + ',' + t.Col + ',' + t.Row).join(';') + '|' + st.suit + '|' + st.chain; // positions too: a shuffle keeps IDs
    if (key === planKey) return planCache;
    const useNeighbors = a.live.length > 0 && Array.isArray(a.live[0].NeighborsLeft);
    const left = a.live.length;
    const runs = [];
    const suits = [...new Set(a.live.map((t) => t.Suit))];
    for (const s of suits) {
      const seq = planSuitRun(a.live, s, a.groupOf, useNeighbors);
      if (!seq.length) continue;
      const cont = s === st.suit && st.chain > 0;
      const c0 = cont ? st.chain + 1 : 1;
      runs.push({ suit: s, name: SUIT_NAMES[s], n: seq.length, seq, cont, c0, pts: streakPoints(s, seq.length, left, c0) });
    }
    runs.sort((x, y) => y.pts - x.pts);
    planKey = key;
    planCache = { streak: st.suit === null ? null : { suit: st.suit, name: SUIT_NAMES[st.suit], chain: st.chain }, runs };
    return planCache;
  }

  // ---------- solver (see solver.js) ----------
  const SOLVE_BUDGET_MS = 45000; // search for a win
  const OPTIMIZE_MS = 30000; // then look for the highest-scoring win (can be cut short from the panel)
  const solver = { on: true, status: 'idle', job: null, path: null, nodes: 0, ms: 0, startIds: null, startPos: null, startTiles: null, t0: 0, resolves: 0 };
  // Where each tile is and what it shows. A shuffle moves tiles around but keeps
  // their IDs, so the solution must be thrown away when any of this changes.
  const posKey = (t) => t.Layer + ',' + t.Col + ',' + t.Row + ',' + t.Suit + '.' + t.Value;
  function boardChanged(a) {
    if (!solver.startIds || a.live.length !== solver.startIds.size) return true;
    for (const t of a.live) if (!solver.startIds.has(t.ID) || solver.startPos.get(t.ID) !== posKey(t)) return true;
    return false;
  }

  // Independent check of a solution against the game's own tile objects and
  // its own rules (calculateIsBlocked + doTilesMatch): replay every move and
  // make sure both tiles are free and match at that moment.
  function verifyPath(tiles, path) {
    const byId = new Map(tiles.map((t) => [t.ID, t]));
    const gone = new Set();
    const inBoard = (x) => x.IsInBoard && !gone.has(x);
    const free = (t) => {
      if (t.NeighborsAbove.some(inBoard)) return false;
      return !(t.NeighborsLeft.some(inBoard) && t.NeighborsRight.some(inBoard));
    };
    for (let i = 0; i < path.length; i++) {
      const x = byId.get(path[i][0]), y = byId.get(path[i][1]);
      if (!x || !y || !inBoard(x) || !inBoard(y)) return { ok: false, step: i, why: 'tile missing' };
      if (!free(x) || !free(y)) return { ok: false, step: i, why: 'tile not free' };
      if (!tilesMatch(x, y)) return { ok: false, step: i, why: 'tiles do not match' };
      gone.add(x); gone.add(y);
    }
    if (gone.size !== tiles.length) return { ok: false, step: path.length, why: 'board not cleared' };
    return { ok: true };
  }

  function solverInput(a) {
    const live = a.live;
    const hasN = live.length && Array.isArray(live[0].NeighborsLeft);
    const ids = (arr) => (arr || []).filter((x) => x && x.IsInBoard).map((x) => x.ID);
    return live.map((t) => {
      let left, right, above;
      if (hasN) { left = ids(t.NeighborsLeft); right = ids(t.NeighborsRight); above = ids(t.NeighborsAbove); }
      else { // geometry fallback: 2x2 footprints in half-tile units
        left = live.filter((u) => u.Layer === t.Layer && u.Col === t.Col - 2 && Math.abs(u.Row - t.Row) < 2).map((u) => u.ID);
        right = live.filter((u) => u.Layer === t.Layer && u.Col === t.Col + 2 && Math.abs(u.Row - t.Row) < 2).map((u) => u.ID);
        above = live.filter((u) => u.Layer === t.Layer + 1 && overlaps(t, u)).map((u) => u.ID);
      }
      return { id: t.ID, group: a.groupOf.get(t), suit: t.Suit, layer: t.Layer, left, right, above };
    });
  }

  function startSolve(board, a) {
    const S = window.__mjsbSolver;
    if (!S) { solver.status = 'error'; return; }
    const st = streakState(board);
    // optimize: once a win is found, spend up to OPTIMIZE_MS finding a
    // higher-scoring way to win (never trading away the win).
    solver.job = S.createSolve(solverInput(a), { lastSuit: st.suit, chain: st.chain, suitValue: SUIT_VALUE, maxNodes: 2e7, maxDead: 3e6, optimize: true, optimizeMs: OPTIMIZE_MS, streaks: true, jitter: 1.5, optimizeTries: 4, streakNodes: 1500, restartMs: 10000 });
    solver.status = 'solving'; solver.phase = 'search'; solver.path = null; solver.nodes = 0; solver.score = null; solver.baseScore = null; solver.optT0 = 0; solver.optBest = 0;
    solver.startIds = new Set(a.live.map((t) => t.ID));
    solver.startPos = new Map(a.live.map((t) => [t.ID, posKey(t)]));
    solver.startTiles = a.live.slice();
    solver.t0 = Date.now();
    setTimeout(pump, 0);
  }

  function pump() {
    if (!solver.job) return;
    let r;
    try { r = solver.job.step(30); } catch (e) { console.warn('[shadow-board] solver', e); solver.job = null; solver.status = 'error'; lastSig = ''; return; }
    solver.nodes = r.nodes;
    if (r.status === 'solving') {
      solver.phase = r.phase || 'search';
      if (solver.phase === 'optimize') { if (!solver.optT0) solver.optT0 = Date.now(); solver.optBest = r.best || 0; }
      if (solver.phase === 'search' && Date.now() - solver.t0 > SOLVE_BUDGET_MS) { solver.status = 'unknown'; solver.job = null; }
      else setTimeout(pump, 0);
    } else {
      solver.status = r.status; solver.path = r.path || null; solver.reason = r.reason || null; solver.job = null;
      solver.score = r.score ?? null; solver.baseScore = r.baseScore ?? null;
      if (r.status === 'win') {
        const chk = Array.isArray(solver.startTiles[0] && solver.startTiles[0].NeighborsLeft) ? verifyPath(solver.startTiles, r.path) : { ok: true };
        solver.verified = chk.ok;
        if (!chk.ok) { // never show a path the game would reject
          console.warn('[shadow-board] solver path failed check', chk);
          solver.status = 'error'; solver.reason = `internal check failed at move ${chk.step + 1} (${chk.why})`; solver.path = null;
        }
      }
    }
    solver.ms = Date.now() - solver.t0;
    lastSig = '';
  }

  // Where is the player along the solution? Re-solve if they left it.
  function solverView(board, a) {
    if (!solver.on) return null;
    const v = { status: solver.status, phase: solver.phase, nodes: solver.nodes, ms: solver.ms, resolves: solver.resolves, reason: solver.reason || null };
    if (solver.status === 'solving' && solver.phase === 'optimize' && solver.optT0) {
      v.optLeft = Math.max(0, Math.ceil((OPTIMIZE_MS - (Date.now() - solver.optT0)) / 1000));
      v.optBest = solver.optBest ? solver.optBest + 288 * (144 / 2) : 0;
    }
    if (solver.status === 'idle' || (solver.status !== 'solving' && !solver.startIds)) { startSolve(board, a); v.status = solver.status; return v; }
    if (solver.status !== 'win') {
      // a finished "lose"/"unknown" result is about the board it was run on
      if (solver.status !== 'solving' && boardChanged(a)) {
        solver.resolves++; startSolve(board, a); v.status = solver.status;
      }
      if (solver.status === 'lose' || solver.status === 'unknown') bestPointsMove(a, v);
      return v;
    }
    const live = new Set(a.live.map((t) => t.ID));
    const path = solver.path;
    let k = 0;
    while (k < path.length && !live.has(path[k][0]) && !live.has(path[k][1])) k++;
    let stillLive = 0;
    for (const id of solver.startIds) if (live.has(id)) stillLive++;
    const removedSinceSolve = solver.startIds.size - stillLive;
    let moved = false;
    for (const t of a.live) if (solver.startPos.get(t.ID) !== posKey(t)) { moved = true; break; }
    if (moved || removedSinceSolve !== 2 * k || live.size !== stillLive) {
      solver.resolves++; startSolve(board, a);
      v.status = solver.status; return v;
    }
    // points still to come if the rest of the path is followed
    const st = streakState(board);
    let last = st.suit, chain = st.chain, left = a.live.length, pts = 0;
    const byId = new Map(a.live.map((t) => [t.ID, t]));
    for (let i = k; i < path.length; i++) {
      const su = byId.get(path[i][0]).Suit;
      chain = su === last ? chain + 1 : 1; last = su;
      pts += 2 * SUIT_VALUE[su] * left * chain; left -= 2;
    }
    v.step = k; v.total = path.length; v.next = path.slice(k, k + 8); v.pts = pts + 288 * (144 / 2);
    if (solver.baseScore && solver.score) v.gain = solver.score - solver.baseScore;
    return v;
  }

  // No win exists (or none was found): still point at a move, the one that
  // starts the best-scoring streak right now.
  function bestPointsMove(a, v) {
    const run = a.plan && a.plan.runs[0];
    if (run && run.seq.length) { v.next = [run.seq[0]]; v.fallback = { suit: run.suit, name: run.name, n: run.n, pts: run.pts }; }
  }

  function applyTints(sc, a) {
    const view = sc._boardView;
    const map = view && view._tileModelToView;
    const want = new Map();
    if (opts.tint && map) {
      for (const t of a.live) {
        let c = null;
        if (a.matchIds.has(t.ID)) c = TINT.match;
        else if (a.solveNext.has(t.ID)) c = TINT.solve;
        else if (a.planNext.has(t.ID)) c = TINT.plan;
        else if (a.danger.has(t)) c = TINT.danger;
        if (c !== null) want.set(t.ID, c);
      }
    }
    // Clear tints we no longer want.
    for (const [id, v] of tinted) {
      if (!want.has(id)) { try { if (v._backSprite) v._backSprite.tint = TINT.none; } catch (e) {} tinted.delete(id); }
    }
    if (!map) return;
    for (const [id, c] of want) {
      const v = map[id];
      if (!v || !v._backSprite) continue;
      if (v._backSprite.tint !== c) v._backSprite.tint = c;
      tinted.set(id, v);
    }
  }

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ src: TAG, v: VERSION }, msg), TOP_ORIGIN); } catch (e) {}
  }

  function tick() {
    const g = game();
    const sc = scene();
    if (!g || !sc) {
      if (lastSig !== 'inactive') { lastSig = 'inactive'; post({ kind: 'state', active: false }); }
      return;
    }
    const board = sc._board;
    if (board !== lastBoard) { lastBoard = board; manualFocusId = null; planSuit = null; planKey = ''; tinted.clear(); solver.job = null; solver.status = 'idle'; solver.startIds = null; solver.resolves = 0; }
    const a = analyse(board);
    a.plan = plan(board, a);
    const pr = planSuit === null ? null : a.plan.runs.find((r) => r.suit === planSuit);
    a.planNext = new Set(pr ? pr.seq[0] : []);
    a.solver = solverView(board, a);
    a.solveNext = new Set(a.solver && a.solver.next && a.solver.next.length ? a.solver.next[0] : []);
    applyTints(sc, a);

    for (const t of a.all) extractFace(g, faceKey(t));

    const sig = [
      a.all.map((t) => (t.IsInBoard ? 1 : 0) + (t.IsBlocked ? 2 : 0) + ':' + t.Suit + '.' + t.Value).join(','),
      a.focus ? a.focus.ID : '-', a.focusSource, opts.tint, opts.danger, planKey, planSuit, JSON.stringify(a.solver),
      Object.keys(faceImg).length,
    ].join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    const tiles = a.all.map((t) => ({
      id: t.ID, l: t.Layer, c: t.Col, r: t.Row,
      face: faceKey(t), label: faceLabel(t), name: SUIT_NAMES[t.Suit] + ' ' + (t.Value + 1),
      g: a.groupOf.get(t), live: !!t.IsInBoard, blocked: !!t.IsBlocked,
      above: a.aboveCount.get(t) || 0,
      danger: a.danger.has(t), twin: a.twin.has(t),
    }));
    const msg = {
      kind: 'state', active: true, tiles,
      focusId: a.focus ? a.focus.ID : null, focusSource: a.focusSource,
      plan: a.plan, planSuit, solver: a.solver,
      matchIds: [...a.matchIds], dangerPairs: a.dangerPairs,
      freePairs: a.freePairs, left: a.live.length, opts,
    };
    const imgCount = Object.values(faceImg).filter(Boolean).length;
    if (imgCount !== imagesSent) { msg.images = faceImg; imagesSent = imgCount; }
    post(msg);
  }

  window.addEventListener('message', (ev) => {
    if (ev.origin !== TOP_ORIGIN || !ev.data || ev.data.src !== TAG) return;
    const d = ev.data;
    if (d.kind === 'focus') manualFocusId = (d.id === manualFocusId ? null : d.id);
    if (d.kind === 'plan') planSuit = (d.suit === planSuit ? null : d.suit);
    if (d.kind === 'solve') { solver.on = !!d.on; solver.job = null; solver.status = 'idle'; solver.path = null; solver.startIds = null; solver.resolves = 0; }
    if (d.kind === 'solveNow' && solver.job && solver.job.stop) solver.job.stop();
    if (d.kind === 'dump') { const sc = scene(); if (sc) post({ kind: 'dump', tiles: solverInput(analyse(sc._board)) }); }
    if (d.kind === 'opts') opts = Object.assign({}, opts, d.opts);
    if (d.kind === 'hello') { lastSig = ''; imagesSent = -1; }
    if (d.kind === 'debug') { try { post({ kind: 'debug', info: debugInfo() }); } catch (e) { post({ kind: 'debug', info: String(e) }); } }
    tick();
  });

  setInterval(() => { try { tick(); } catch (e) { console.warn('[shadow-board]', e); } }, POLL_MS);
})();
