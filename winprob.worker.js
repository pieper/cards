"use strict";
/* ===========================================================================
 * Win-probability estimator (runs in a Web Worker; no DOM).
 *
 * Given the CURRENTLY-VISIBLE position, we sample many "determinizations" —
 * random identities for the face-down tableau cards and the stock, consistent
 * with everything on show (assuming no deck memorization) — and play each one
 * out with fixed, objective greedy policies. The fraction won estimates the
 * chance the position is winnable under that standard of play. Three policies of
 * increasing strength give pessimistic / expected / optimistic bands. Nothing
 * here depends on who is playing.
 *
 * Card id = suit*13 + (rank-1);  suits 0=♠ 1=♥ 2=♦ 3=♣ (1,2 = red).
 * ==========================================================================*/

const suitOf = id => (id / 13) | 0;
const rankOf = id => (id % 13) + 1;
const redId  = id => { const s = suitOf(id); return s === 1 || s === 2; };

function clone(st){
  return {
    draw: st.draw,
    stock: st.stock.slice(),
    waste: st.waste.slice(),
    found: st.found.map(a => a.slice()),
    down:  st.down.map(a => a.slice()),
    up:    st.up.map(a => a.slice()),
  };
}

/* ---- legality ---- */
function canFound(st, id){
  const f = st.found[suitOf(id)], r = rankOf(id);
  return f.length ? rankOf(f[f.length - 1]) === r - 1 : r === 1;
}
function canTab(st, id, k){
  const up = st.up[k];
  if (!up.length) return st.down[k].length ? false : rankOf(id) === 13;   // empty column → King
  const t = up[up.length - 1];
  return redId(id) !== redId(t) && rankOf(id) === rankOf(t) - 1;
}
function validRun(cards){
  for (let i = 1; i < cards.length; i++)
    if (redId(cards[i-1]) === redId(cards[i]) || rankOf(cards[i]) !== rankOf(cards[i-1]) - 1) return false;
  return true;
}
const won = st => st.found[0].length + st.found[1].length + st.found[2].length + st.found[3].length === 52;

function flip(st, i){ if (!st.up[i].length && st.down[i].length) st.up[i].push(st.down[i].pop()); }

/* ---- safe auto-play to the foundations ---- */
function isSafe(st, id){
  const r = rankOf(id);
  if (r <= 2) return true;
  const red = redId(id);
  let oppMin = 99;
  for (let s = 0; s < 4; s++) if (redId(s * 13) !== red) oppMin = Math.min(oppMin, st.found[s].length);
  return oppMin >= r - 1;
}
function autoSafe(st){
  let any = false, moved = true;
  while (moved){
    moved = false;
    if (st.waste.length){
      const w = st.waste[st.waste.length - 1];
      if (canFound(st, w) && isSafe(st, w)){ st.found[suitOf(w)].push(st.waste.pop()); moved = any = true; continue; }
    }
    for (let i = 0; i < 7; i++){
      const up = st.up[i];
      if (up.length){
        const t = up[up.length - 1];
        if (canFound(st, t) && isSafe(st, t)){ st.found[suitOf(t)].push(up.pop()); flip(st, i); moved = any = true; }
      }
    }
  }
  return any;
}

/* ---- productive move generation (mirrors the in-game "no pointless lateral") ---- */
function genMoves(st){
  const mv = [];
  const w = st.waste.length ? st.waste[st.waste.length - 1] : -1;
  if (w >= 0){
    if (canFound(st, w)) mv.push({ s: 100, t: "wf" });
    for (let k = 0; k < 7; k++) if (canTab(st, w, k)) mv.push({ s: 55, t: "wt", k });
  }
  for (let i = 0; i < 7; i++){
    const up = st.up[i];
    if (up.length){ const top = up[up.length - 1]; if (canFound(st, top)) mv.push({ s: 95, t: "tf", i }); }
    for (let j = 0; j < up.length; j++){
      const run = up.slice(j);
      if (!validRun(run)) continue;
      const exposes = j === 0 && st.down[i].length > 0;
      const empties = j === 0 && st.down[i].length === 0;
      if (!exposes && !empties) continue;                  // lateral shuffle → not productive
      for (let k = 0; k < 7; k++){
        if (k === i || !canTab(st, run[0], k)) continue;
        if (empties && !st.up[k].length && !st.down[k].length) continue;  // whole pile → empty column: pointless
        mv.push({ s: exposes ? 120 : 80, t: "tt", i, j, k });
      }
    }
  }
  return mv;
}
function applyMove(st, m){
  if (m.t === "wf"){ const w = st.waste.pop(); st.found[suitOf(w)].push(w); }
  else if (m.t === "wt"){ st.up[m.k].push(st.waste.pop()); }
  else if (m.t === "tf"){ const c = st.up[m.i].pop(); st.found[suitOf(c)].push(c); flip(st, m.i); }
  else if (m.t === "tt"){ const run = st.up[m.i].splice(m.j); for (const c of run) st.up[m.k].push(c); flip(st, m.i); }
}
function draw(st){ for (let i = 0; i < st.draw && st.stock.length; i++) st.waste.push(st.stock.pop()); }
function recycle(st){ while (st.waste.length) st.stock.push(st.waste.pop()); }

// weak = only reveal face-down cards + auto-safe foundations; mid = full greedy
// (deterministic); rand = full greedy with random tie-breaks.
function pick(st, mode, rng){
  let mv = genMoves(st);
  if (mode === "weak") mv = mv.filter(m => (m.t === "tt" && m.s === 120) || m.t === "tf" || m.t === "wf");
  if (!mv.length) return null;
  let best = -1; for (const m of mv) if (m.s > best) best = m.s;
  const top = mv.filter(m => m.s === best);
  return mode === "rand" ? top[(rng() * top.length) | 0] : top[0];
}

function rollout(st0, mode, rng){
  const st = clone(st0);
  autoSafe(st);
  let dsp = 0;                                             // draws since last play
  for (let step = 0; step < 4000; step++){
    if (won(st)) return true;
    const m = pick(st, mode, rng);
    if (m){ applyMove(st, m); autoSafe(st); dsp = 0; continue; }
    const D = st.stock.length + st.waste.length;
    if (D === 0) return false;                             // no deck, no move → stuck
    if (!st.stock.length) recycle(st);
    draw(st);
    if (autoSafe(st)) { dsp = 0; continue; }
    if (++dsp > Math.ceil(D / st.draw) + 2) return false;  // a full deck cycle with no progress
  }
  return won(st);
}

/* ---- determinize the belief state, then estimate ---- */
function determinize(pub, rng){
  const known = new Set();
  pub.up.forEach(a => a.forEach(id => known.add(id)));
  pub.waste.forEach(id => known.add(id));
  pub.found.forEach(a => a.forEach(id => known.add(id)));
  const pool = [];
  for (let id = 0; id < 52; id++) if (!known.has(id)) pool.push(id);
  for (let i = pool.length - 1; i > 0; i--){ const j = (rng() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  let p = 0;
  const st = { draw: pub.draw, waste: pub.waste.slice(), found: pub.found.map(a => a.slice()),
               up: pub.up.map(a => a.slice()), down: pub.down.map(() => []), stock: [] };
  for (let i = 0; i < 7; i++) for (let d = 0; d < pub.down[i]; d++) st.down[i].push(pool[p++]);
  for (let s = 0; s < pub.stockN; s++) st.stock.push(pool[p++]);
  return st;
}

// For each determinized world we try K greedy lines (random tie-breaks). The band
// reflects how much your CHOICES matter from here, not who's playing:
//   optimistic = worlds winnable by SOME line   (a way through exists)
//   expected   = mean line win rate             (a typical playthrough)
//   pessimistic= worlds winnable by EVERY line  (robustly won, hard to spoil)
function estimate(pub, N, rng){
  rng = rng || Math.random;
  const K = 4;
  let any = 0, all = 0, mean = 0;
  for (let n = 0; n < N; n++){
    const det = determinize(pub, rng);
    let wins = 0;
    for (let k = 0; k < K; k++) if (rollout(det, "rand", rng)) wins++;
    if (wins > 0) any++;
    if (wins === K) all++;
    mean += wins / K;
  }
  return { low: all / N, mid: mean / N, high: any / N, n: N };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function"){
  self.onmessage = (e) => {
    const { id, pub, N } = e.data;
    let res;
    try { res = estimate(pub, N || 48); }
    catch { res = { low: 0, mid: 0, high: 0, n: 0 }; }
    self.postMessage({ id, ...res });
  };
}
if (typeof module !== "undefined") module.exports = { estimate, rollout, determinize, clone, won };
