// Runs on games.washingtonpost.com. Draws the floating shadow board from the
// snapshots posted by frame.js inside the game iframe.
(() => {
  'use strict';
  const TAG = 'mjsb';
  const FRAME_ORIGIN = 'https://arenacloud.cdn.arkadiumhosted.com';
  const STORE = 'mjsb-ui';
  const LAYER_NAMES = ['Layer 1 (bottom)', 'Layer 2', 'Layer 3', 'Layer 4', 'Layer 5 (top)'];

  const ui = Object.assign(
    { x: null, y: 120, unit: 13, min: false, tint: true, danger: true },
    load()
  );
  let state = null;
  const images = {};
  let layerBounds = null; // computed once per board (from all tiles, incl. removed)
  let boardSig = '';

  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(ui)); } catch (e) {} }

  // ---------- DOM ----------
  const root = document.createElement('div');
  root.id = 'mjsb-root';
  root.innerHTML = `
    <div class="mjsb-head">
      <span class="mjsb-title">Shadow Board</span>
      <span class="mjsb-stats"></span>
      <span class="mjsb-btns">
        <button data-act="smaller" title="Smaller">−</button>
        <button data-act="bigger" title="Bigger">+</button>
        <button data-act="min" title="Minimize">▁</button>
      </span>
    </div>
    <div class="mjsb-body">
      <div class="mjsb-controls">
        <label><input type="checkbox" data-opt="tint"> Tint real board</label>
        <label><input type="checkbox" data-opt="danger"> Flag buried twins</label>
        <button data-act="clear">Clear focus</button>
        <button data-act="solve" class="mjsb-solvebtn">Solver on</button>
      </div>
      <div class="mjsb-solver"></div>
      <div class="mjsb-focus"></div>
      <div class="mjsb-streaks"></div>
      <div class="mjsb-layers"></div>
      <div class="mjsb-danger"></div>
      <div class="mjsb-legend">
        <span><i class="lg free"></i>free</span>
        <span><i class="lg blocked"></i>blocked</span>
        <span><i class="lg hidden"></i>hidden (covered)</span>
        <span><i class="lg match"></i>match</span>
        <span><i class="lg danger"></i>on top of its twin</span>
        <span><i class="lg twin"></i>buried twin</span>
        <span><i class="lg gone"></i>removed</span>
        <span><i class="lg plan"></i>streak order</span>
        <span><i class="lg sol"></i>next moves to win</span>
      </div>
    </div>`;
  document.documentElement.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const elStats = $('.mjsb-stats'), elFocus = $('.mjsb-focus'), elLayers = $('.mjsb-layers'), elDanger = $('.mjsb-danger'), elStreaks = $('.mjsb-streaks'), elSolver = $('.mjsb-solver'), btnSolve = $('.mjsb-solvebtn');
  root.querySelectorAll('[data-opt]').forEach((cb) => { cb.checked = !!ui[cb.dataset.opt]; });

  function place() {
    const w = root.offsetWidth || 420;
    if (ui.x === null) ui.x = Math.max(8, window.innerWidth - w - 16);
    ui.x = Math.min(Math.max(0, ui.x), Math.max(0, window.innerWidth - 60));
    ui.y = Math.min(Math.max(0, ui.y), Math.max(0, window.innerHeight - 30));
    root.style.left = ui.x + 'px';
    root.style.top = ui.y + 'px';
    root.classList.toggle('mjsb-min', !!ui.min);
    root.style.setProperty('--u', ui.unit + 'px');
  }
  place();
  window.addEventListener('resize', place);

  // Drag by header.
  (() => {
    let sx, sy, ox, oy, dragging = false;
    $('.mjsb-head').addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY; ox = ui.x; oy = ui.y; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      ui.x = ox + e.clientX - sx; ui.y = oy + e.clientY - sy; place();
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; save(); } });
  })();

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) {
      const a = b.dataset.act;
      if (a === 'smaller') ui.unit = Math.max(7, ui.unit - 2);
      if (a === 'bigger') ui.unit = Math.min(30, ui.unit + 2);
      if (a === 'min') ui.min = !ui.min;
      if (a === 'solve') { send({ kind: 'solve', on: !(state && state.solver) }); return; }
      if (a === 'clear') send({ kind: 'focus', id: state && state.focusSource === 'shadow' ? state.focusId : null });
      save(); place(); render();
      return;
    }
    const sb = e.target.closest('[data-suit]');
    if (sb) { send({ kind: 'plan', suit: Number(sb.dataset.suit) }); return; }
    const t = e.target.closest('[data-id]');
    if (t) send({ kind: 'focus', id: Number(t.dataset.id) });
  });
  root.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-opt]');
    if (!cb) return;
    ui[cb.dataset.opt] = cb.checked; save();
    send({ kind: 'opts', opts: { tint: ui.tint, danger: ui.danger } });
  });

  // ---------- messaging ----------
  function frameWin() {
    const f = document.getElementById('canvas-box') ||
      [...document.querySelectorAll('iframe')].find((i) => (i.src || '').startsWith(FRAME_ORIGIN));
    return f && f.contentWindow;
  }
  function send(msg) {
    const w = frameWin();
    if (w) w.postMessage(Object.assign({ src: TAG }, msg), FRAME_ORIGIN);
  }
  window.addEventListener('message', (ev) => {
    if (ev.origin !== FRAME_ORIGIN || !ev.data || ev.data.src !== TAG || ev.data.kind !== 'state') return;
    if (ev.data.images) Object.assign(images, ev.data.images);
    state = ev.data;
    render();
  });
  // Say hello until the frame answers (frame may load after us), and push our options.
  const hello = setInterval(() => {
    send({ kind: 'opts', opts: { tint: ui.tint, danger: ui.danger } });
    send({ kind: 'hello' });
    if (state) clearInterval(hello);
  }, 1000);

  // ---------- rendering ----------
  function computeBounds(tiles) {
    const b = [];
    for (const t of tiles) {
      const x = b[t.l] || (b[t.l] = { c0: Infinity, r0: Infinity, c1: -Infinity, r1: -Infinity });
      x.c0 = Math.min(x.c0, t.c); x.r0 = Math.min(x.r0, t.r);
      x.c1 = Math.max(x.c1, t.c + 2); x.r1 = Math.max(x.r1, t.r + 2);
    }
    return b;
  }

  const byId = () => new Map(state.tiles.map((t) => [t.id, t]));

  function tileHTML(t, b, opts) {
    const sstep = opts.solveStep.get(t.id);
    const step = sstep ? null : opts.planStep.get(t.id);
    const cls = ['mjsb-t', 's' + t.face.slice(5, 6)];
    if (!t.live) cls.push('gone');
    else {
      cls.push(t.blocked ? 'blocked' : 'free');
      if (t.above > 0) cls.push('hidden');
      if (t.danger) cls.push('danger');
      if (t.twin) cls.push('twin');
    }
    if (opts.matches.has(t.id)) cls.push('match');
    if (t.id === state.focusId) cls.push('focus');
    if (step) cls.push('plan', step === 1 ? 'plan-now' : 'plan-later');
    if (sstep) cls.push('sol', sstep === 1 ? 'sol-now' : 'sol-later');
    const x = (t.c - b.c0), y = (t.r - b.r0);
    const img = t.live && images[t.face];
    const inner = !t.live ? '' : img ? `<img src="${img}" alt="">` : `<span>${t.label}</span>`;
    const tip = `${t.name} — ${!t.live ? 'removed' : t.blocked ? 'blocked' : 'free'}` +
      (t.live && t.above ? `, under ${t.above} tile${t.above > 1 ? 's' : ''}` : '') +
      (t.danger ? ' — sits above its own twin: clear early!' : '') +
      (t.twin ? ' — buried under its own twin' : '');
    const badge = (t.live && t.above ? `<b class="cov">${t.above}</b>` : '') + (step ? `<b class="step">${step}</b>` : '') + (sstep ? `<b class="step sstep">${sstep}</b>` : '');
    return `<div class="${cls.join(' ')}" data-id="${t.id}" title="${tip}" style="left:calc(var(--u)*${x});top:calc(var(--u)*1.3*${y})">${inner}${badge}</div>`;
  }

  function render() {
    if (!state || !state.active) {
      elStats.textContent = state ? 'waiting for a game…' : 'connecting…';
      elLayers.innerHTML = '<div class="mjsb-wait">Start or continue a game to see the board.</div>';
      elFocus.textContent = ''; elDanger.innerHTML = ''; elStreaks.innerHTML = ''; elSolver.innerHTML = '';
      return;
    }
    const tiles = state.tiles;
    const sig = tiles.map((t) => t.id + '@' + t.l + ',' + t.c + ',' + t.r).join(';');
    if (sig !== boardSig) { boardSig = sig; layerBounds = computeBounds(tiles); }

    const ids = byId();
    const matches = new Set(state.matchIds);
    const planStep = new Map();
    const pl = state.plan || { runs: [] };
    const run = state.planSuit == null ? null : pl.runs.find((r) => r.suit === state.planSuit);
    if (run) run.seq.forEach((pair, i) => pair.forEach((id) => planStep.set(id, i + 1)));
    const sv = state.solver;
    const solveStep = new Map();
    if (sv && sv.next) sv.next.slice(0, 5).forEach((pair, i) => pair.forEach((id) => solveStep.set(id, i + 1)));
    const live = tiles.filter((t) => t.live);
    const nDanger = live.filter((t) => t.danger).length;
    const verdict = !sv ? '' : sv.status === 'solving' ? ' · ⏳ checking…'
      : sv.status === 'win' ? (sv.step >= sv.total ? ' · ✓ cleared' : ' · ✓ winnable')
      : sv.status === 'lose' ? ' · ✗ not winnable' : sv.status === 'unknown' ? ' · ? no win found yet' : '';
    elStats.textContent = `${state.left} left · ${state.freePairs} free pair${state.freePairs === 1 ? '' : 's'}` +
      (nDanger ? ` · ⚠ ${nDanger}` : '') + verdict;
    elStats.dataset.verdict = sv ? sv.status : '';

    // Layers
    let html = '';
    layerBounds.forEach((b, l) => {
      if (!b) return;
      const w = b.c1 - b.c0, h = b.r1 - b.r0;
      // faint ghost of the layer below, for orientation
      const ghost = tiles.filter((t) => t.l === l - 1 && t.live && t.c + 2 > b.c0 && t.c < b.c1 && t.r + 2 > b.r0 && t.r < b.r1)
        .map((t) => `<div class="mjsb-ghost" style="left:calc(var(--u)*${t.c - b.c0});top:calc(var(--u)*1.3*${t.r - b.r0})"></div>`).join('');
      const own = tiles.filter((t) => t.l === l).map((t) => tileHTML(t, b, { matches, planStep, solveStep })).join('');
      const nLive = tiles.filter((t) => t.l === l && t.live).length;
      html += `<div class="mjsb-layer"><div class="mjsb-lname">${LAYER_NAMES[l] || 'Layer ' + (l + 1)} <em>${nLive}</em></div>
        <div class="mjsb-grid" style="width:calc(var(--u)*${w});height:calc(var(--u)*1.3*${h})">${ghost}${own}</div></div>`;
    });
    elLayers.innerHTML = html;

    const fmt = (n) => n.toLocaleString('en-US');

    // Solver
    btnSolve.textContent = sv ? 'Solver on' : 'Solver off';
    btnSolve.title = sv ? 'Click to turn the solver off' : 'Click to turn the solver on';
    btnSolve.classList.toggle('on', !!sv);
    if (!sv) elSolver.innerHTML = '';
    else {
      const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
      const where = (t) => `L${t.l + 1}${t.blocked ? '' : ' free'}`;
      let h = '';
      if (sv.status === 'solving') h = `<div class="mjsb-sstat">⏳ Searching… ${k(sv.nodes)} positions tried</div>`;
      else if (sv.status === 'lose') h = `<div class="mjsb-sstat bad">✗ Not winnable from here without a shuffle` + (sv.reason ? ` (${sv.reason})` : ` — checked every line (${k(sv.nodes)} positions)`) + `.</div>`;
      else if (sv.status === 'unknown') h = `<div class="mjsb-sstat warn">? No win found yet (${k(sv.nodes)} positions, ${Math.round(sv.ms / 1000)}s). It may still be winnable: it checks again after every move.</div>`;
      else if (sv.status === 'error') h = `<div class="mjsb-sstat bad">Solver error${sv.reason ? ': ' + sv.reason : ''}. No moves suggested.</div>`;
      else if (sv.status === 'win' && sv.step >= sv.total) h = `<div class="mjsb-sstat good">✓ Solved — board cleared!</div>`;
      else if (sv.status === 'win') {
        const steps = sv.next.map(([x, y], i) => {
          const a = ids.get(x), b = ids.get(y);
          return `<li class="${i === 0 ? 'now' : ''}"><a data-id="${x}">${a.name}</a> <span class="dim">${where(a)}</span> + <a data-id="${y}">${b.name}</a> <span class="dim">${where(b)}</span></li>`;
        }).join('');
        h = `<div class="mjsb-sstat good">✓ Winnable — move ${sv.step + 1} of ${sv.total}` +
          ` <span class="dim">· ~${fmt(sv.pts)} pts if you follow it` + (sv.resolves ? ` · re-planned ${sv.resolves}×` : '') + `</span></div>` +
          `<ol class="mjsb-steps" start="${sv.step + 1}">${steps}</ol>`;
      }
      if ((sv.status === 'lose' || sv.status === 'unknown') && sv.fallback && sv.next && sv.next[0]) {
        const [x, y] = sv.next[0], a = ids.get(x), b = ids.get(y);
        h += `<div class="mjsb-sfall">Best move for points: <a data-id="${x}">${a.name}</a> <span class="dim">${where(a)}</span> + ` +
          `<a data-id="${y}">${b.name}</a> <span class="dim">${where(b)}</span> <span class="dim">· starts a ${sv.fallback.n}-pair ${sv.fallback.name} streak (~${fmt(sv.fallback.pts)})</span></div>`;
      }
      elSolver.innerHTML = h;
    }

    // Streaks
    const cur = pl.streak && pl.streak.chain > 0 ? `Current streak: <b>${pl.streak.name} ×${pl.streak.chain}</b>` : 'No streak yet';
    const rows = pl.runs.slice(0, 6).map((r) => {
      const sel = r.suit === state.planSuit ? ' sel' : '';
      const mult = r.n > 1 || r.cont ? ` <em>×${r.c0}${r.n > 1 ? '→×' + (r.c0 + r.n - 1) : ''}</em>` : '';
      return `<div class="mjsb-run s${r.suit + 1}${sel}" data-suit="${r.suit}"><span class="nm">${r.name}</span>` +
        `<span class="n">${r.n} pair${r.n > 1 ? 's' : ''} in a row${mult}</span><span class="pts">~${fmt(r.pts)}</span></div>`;
    }).join('');
    elStreaks.innerHTML = `<div class="mjsb-shead">${cur} <span class="dim">· click a suit to see its order (1, 2, 3…)</span></div>` +
      (rows || '<div class="dim">No free pairs right now.</div>');

    // Focus summary
    const f = state.focusId !== null ? ids.get(state.focusId) : null;
    if (f) {
      const parts = state.matchIds.map((id) => ids.get(id)).filter(Boolean)
        .sort((a, b) => a.l - b.l)
        .map((t) => {
          const st = t.blocked ? (t.above ? `hidden under ${t.above}` : 'blocked') : 'FREE';
          return `<a data-id="${t.id}" class="${t.blocked ? '' : 'ok'}">L${t.l + 1} ${st}</a>`;
        });
      const src = state.focusSource === 'game' ? 'Selected in game' : 'Inspecting';
      elFocus.innerHTML = `<b>${src}: ${f.name}</b> → ${parts.length ? parts.join(' · ') : 'no matches left on the board'}`;
    } else {
      elFocus.innerHTML = '<span class="dim">Click a tile in the game (or here) to see where its matches are.</span>';
    }

    // Danger list
    if (state.dangerPairs.length) {
      const seen = new Set();
      const items = state.dangerPairs.filter(([a]) => !seen.has(a) && seen.add(a)).map(([a, u]) => {
        const t = ids.get(a), w = ids.get(u);
        return `<li><a data-id="${t.id}">${t.name}</a> on L${t.l + 1} sits above its twin on L${w.l + 1}</li>`;
      });
      elDanger.innerHTML = `<div class="mjsb-dhead">⚠ Clear these early — each is stacked on its own match:</div><ul>${items.join('')}</ul>`;
    } else {
      elDanger.innerHTML = ui.danger ? '<div class="dim">No tiles are stacked on their own twins.</div>' : '';
    }
  }
  render();
})();
