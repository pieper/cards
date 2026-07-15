/* ============================================================================
 * Klondike Solitaire  —  drag, throw-to-play physics, turn-3, autoplay, win art
 * Single-file, no dependencies. MIT-ish, do what you like.
 * ==========================================================================*/
"use strict";

/* ---------------------------------------------------------------- config -- */

// Geometry (design coordinates; the whole board is scaled to fit the window).
const CARD_W = 120, CARD_H = 168, PAD = 20, GAP = 18;
const FACE_UP_OFF = 40, FACE_DOWN_OFF = 18, WASTE_FAN = 32;
// The Phone deck fans exposed cards farther apart so a covered card still shows
// its full big rank (the rank sits lower on that card than on the art decks).
const PHONE_FACE_UP_OFF = 68;
const TABLEAU_TOP = PAD + CARD_H + 28;

// Throw / animation feel.
const THROW_SPEED   = 320;   // px/s of release velocity to count as a "throw"
const THROW_CONE    = 0.45;  // min cos(angle) between throw & target direction (~63°)
const MAX_THROW_VEL = 2400;  // clamp seeded velocity so it never goes wild
const SPRING_K      = 175;   // stiffness  (pull)
const SPRING_D      = 24;    // damping     (lower = livelier, higher = stiffer)

// Win-screen images. Loaded as plain <img> (no fetch, so no CORS needed at all).
// LoremFlickr serves random Creative-Commons photos BY KEYWORD, so the ~1-in-3
// "prize" can be glamour shots while the rest are nice random photos of anything.
// Edit the keyword pools freely.
const WIN_IMAGE = {
  prizeOdds: 0.8,           // the game's hard — reward it: mostly glamour, occasional dud
  size: [640, 800],
  // IMPORTANT: single tags only. LoremFlickr AND-matches multiple tags, which
  // shrinks the pool to almost nothing (measured 1 image); one broad tag draws
  // from a large pool (measured all-distinct). Rotating tags adds more variety.
  prizeTags:  ["model", "glamour", "fashion", "woman", "portrait", "beauty"],
  randomTags: ["landscape", "nature", "city", "wildlife", "mountain",
               "beach", "flowers", "forest", "sunset", "architecture"],
  puppyTags:  ["puppy", "dog", "labrador", "retriever", "corgi", "beagle"],
};

// iPad / iPhone (incl. iPadOS 13+ which masquerades as "MacIntel" but has touch).
const IS_APPLE_TOUCH = /iP(ad|hone|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1);

/* ----------------------------------------------------------------- model -- */

const SUITS  = ["spades","hearts","diamonds","clubs"];
const SYMBOL = ["♠","♥","♦","♣"];
const RANKS  = ["","A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const isRed  = s => s === 1 || s === 2;
const colorOf = s => (isRed(s) ? "red" : "black");

// Pip layouts as fractional [x,y] within the face. y>0.5 pips render inverted.
const PIPS = {
  2:[[.5,.18],[.5,.82]],
  3:[[.5,.18],[.5,.5],[.5,.82]],
  4:[[.28,.18],[.72,.18],[.28,.82],[.72,.82]],
  5:[[.28,.18],[.72,.18],[.5,.5],[.28,.82],[.72,.82]],
  6:[[.28,.18],[.72,.18],[.28,.5],[.72,.5],[.28,.82],[.72,.82]],
  7:[[.28,.18],[.72,.18],[.5,.34],[.28,.5],[.72,.5],[.28,.82],[.72,.82]],
  8:[[.28,.18],[.72,.18],[.5,.34],[.28,.5],[.72,.5],[.5,.66],[.28,.82],[.72,.82]],
  9:[[.28,.18],[.72,.18],[.28,.4],[.72,.4],[.5,.5],[.28,.6],[.72,.6],[.28,.82],[.72,.82]],
  10:[[.28,.18],[.72,.18],[.5,.3],[.28,.4],[.72,.4],[.28,.6],[.72,.6],[.5,.7],[.28,.82],[.72,.82]],
};

const G = {
  piles: {},          // stock, waste, foundations[4], tableau[7]
  byId: {},
  history: [],
  scale: 1,
  drag: null,
};

function makePile(type, index){ return { type, index, cards: [], el: null }; }

function buildPiles(){
  G.piles = {
    stock: makePile("stock", 0),
    waste: makePile("waste", 0),
    foundations: [0,1,2,3].map(i => makePile("foundation", i)),
    tableau: [0,1,2,3,4,5,6].map(i => makePile("tableau", i)),
  };
}

function eachPile(fn){
  fn(G.piles.stock); fn(G.piles.waste);
  G.piles.foundations.forEach(fn); G.piles.tableau.forEach(fn);
}

/* -------------------------------------------------------------- geometry -- */

const colX = i => PAD + i * (CARD_W + GAP);

function pileBaseXY(p){
  if (p.type === "stock")      return { x: colX(0),      y: PAD };
  if (p.type === "waste")      return { x: colX(1),      y: PAD };
  if (p.type === "foundation") return { x: colX(3 + p.index), y: PAD };
  return { x: colX(p.index), y: TABLEAU_TOP }; // tableau
}

// Where card #index in pile p sits (its top-left, in design coords).
function cardXY(p, index){
  const base = pileBaseXY(p);
  if (p.type === "tableau"){
    const upOff = DECKS[currentDeck].type === "phone" ? PHONE_FACE_UP_OFF : FACE_UP_OFF;
    let y = base.y;
    for (let i = 0; i < index; i++) y += p.cards[i].faceUp ? upOff : FACE_DOWN_OFF;
    return { x: base.x, y };
  }
  if (p.type === "waste"){
    const n = p.cards.length;
    const fan = Math.max(0, index - (n - 3));     // only last 3 fan out
    return { x: base.x + fan * WASTE_FAN, y: base.y };
  }
  return base; // stock & foundation stack in place
}

// Landing position for a newly-appended card (used by throw targeting).
function landingXY(p){ return cardXY(p, p.cards.length); }

/* ----------------------------------------------------------------- rules -- */

const topCard = p => p.cards[p.cards.length - 1] || null;

function canDropFoundation(card, f){
  const t = topCard(f);
  return t ? (card.suit === t.suit && card.rank === t.rank + 1)
           : card.rank === 1;
}
function canDropTableau(card, p){
  const t = topCard(p);
  return t ? (colorOf(card.suit) !== colorOf(t.suit) && card.rank === t.rank - 1)
           : card.rank === 13;
}
// Is [lead..end] of a tableau pile a movable alternating-descending run?
function isValidRun(cards){
  for (let i = 1; i < cards.length; i++){
    const a = cards[i-1], b = cards[i];
    if (colorOf(a.suit) === colorOf(b.suit) || b.rank !== a.rank - 1) return false;
  }
  return true;
}
function canDrop(group, p){
  if (p.type === "foundation") return group.length === 1 && canDropFoundation(group[0], p);
  if (p.type === "tableau")    return isValidRun(group) && canDropTableau(group[0], p);
  return false;
}

/* ------------------------------------------------------------ DOM / cards -- */

const boardEl = document.getElementById("board");

// Bundled card art, all freely licensed and shipped locally.
const RANK_NAME = ["","ace","2","3","4","5","6","7","8","9","10","jack","queen","king"];
const DECKS = {
  knoll: { label: "Classic", dir: "assets/decks/knoll" },   // Byron Knoll, public domain
  fomin: { label: "English", dir: "assets/decks/fomin" },   // Dmitry Fomin, CC0
  phone: { label: "Phone",   type: "phone" },               // big-rank deck, drawn in JS
};
let currentDeck = "knoll";
const cardFile = card => `${DECKS[currentDeck].dir}/${RANK_NAME[card.rank]}_of_${SUITS[card.suit]}.svg`;

/* --- "Phone" deck: huge Arial rank + vector pips, single head on the courts --- */
// Suit pip paths in a 32×32 box (indexed by suit: spades,hearts,diamonds,clubs).
const SUIT_PATH = [
  "M16 3 C16 3 4 12 4 19 C4 22.5 6.4 24.5 9.3 24.5 C11 24.5 12.3 23.6 12.3 23.6 C12 26 11 28.5 8.5 30 L23.5 30 C21 28.5 20 26 19.7 23.6 C19.7 23.6 21 24.5 22.7 24.5 C25.6 24.5 28 22.5 28 19 C28 12 16 3 16 3 Z",
  "M16 29 C16 29 4 20 4 11.5 C4 7 7.5 4 11 4 C13.7 4 16 6.5 16 6.5 C16 6.5 18.3 4 21 4 C24.5 4 28 7 28 11.5 C28 20 16 29 16 29 Z",
  "M16 2 L28 16 L16 30 L4 16 Z",
  "M16 3 C13.2 3 11 5.2 11 8 C11 9.1 11.4 10.1 12 10.9 C11.6 10.7 11.1 10.6 10.6 10.6 C7.8 10.6 5.6 12.8 5.6 15.6 C5.6 18.4 7.8 20.6 10.6 20.6 C12.4 20.6 14 19.6 14.8 18.2 C14.6 21 13.4 25.5 10.5 30 L21.5 30 C18.6 25.5 17.4 21 17.2 18.2 C18 19.6 19.6 20.6 21.4 20.6 C24.2 20.6 26.4 18.4 26.4 15.6 C26.4 12.8 24.2 10.6 21.4 10.6 C20.9 10.6 20.4 10.7 20 10.9 C20.6 10.1 21 9.1 21 8 C21 5.2 18.8 3 16 3 Z",
];
const PHONE_COLOR = ["#111111", "#df0000", "#df0000", "#111111"];   // by suit index
// Every card: one BIG rank (upper-left) + one BIG suit pip (lower-right), so
// colour and suit read clearly on a small screen — face cards included.
// The pip is a <g class="bigpip"> centred at the SVG origin; CSS positions/sizes
// it (big lower-right normally, up beside the rank when the card is covered) and
// transitions between the two, so the colour stays readable in a fanned stack.
function phoneCardSVG(card){
  const col = PHONE_COLOR[card.suit], d = SUIT_PATH[card.suit];
  const label = RANKS[card.rank];
  return `<svg class="cardsvg" viewBox="0 0 250 350" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="18" y="120" font-family="Arial,Helvetica,sans-serif" font-weight="bold" font-size="130" fill="${col}">${label}</text>` +
    `<g class="bigpip"><path transform="translate(-16 -16)" fill="${col}" d="${d}"/></g>` +
    `</svg>`;
}

// Minimal CSS fallback face if an SVG asset fails to load.
function textFace(card){
  const sym = SYMBOL[card.suit], r = RANKS[card.rank];
  return `<div class="corner tl"><span class="r">${r}</span><span class="s">${sym}</span></div>` +
         `<div class="corner br"><span class="r">${r}</span><span class="s">${sym}</span></div>` +
         `<div class="center-suit">${sym}</div>`;
}

// A face-up tableau card is "covered" when another card sits on top of it.
function cardCovered(card){
  const loc = findCard(card.id);
  return !!loc && loc.pile.type === "tableau" && loc.index < loc.pile.cards.length - 1;
}

function renderCard(card){
  const el = card.el;
  el.style.width = CARD_W + "px"; el.style.height = CARD_H + "px";
  if (!card.faceUp){ el.className = "card back"; el.innerHTML = ""; return; }

  el.className = `card face ${colorOf(card.suit)}`;
  if (DECKS[currentDeck].type === "phone"){
    el.innerHTML = phoneCardSVG(card);
    el.classList.toggle("covered", cardCovered(card));   // correct at creation → no anim
    return;
  }
  const img = new Image();
  img.draggable = false;
  img.alt = `${RANKS[card.rank]}${SYMBOL[card.suit]}`;
  img.onerror = () => { el.innerHTML = textFace(card); };
  img.src = cardFile(card);
  el.innerHTML = "";
  el.appendChild(img);
}

function place(card, x, y, z){
  card.el.style.transform = `translate(${x}px,${y}px)`;
  if (z != null) card.el.style.zIndex = z;
}

function layout(){
  let z = 0, maxBottom = TABLEAU_TOP + CARD_H;
  eachPile(p => {
    p.cards.forEach((card, i) => {
      const { x, y } = cardXY(p, i);
      card.home = { x, y };
      place(card, x, y, ++z);
      // A tableau card with something stacked on it is "covered" → pip slides up.
      // Elements that persist across the move animate; freshly rendered ones were
      // already set correctly in renderCard, so this is a no-op for them.
      card.el.classList.toggle("covered", p.type === "tableau" && i < p.cards.length - 1);
      maxBottom = Math.max(maxBottom, y + CARD_H);
    });
  });
  boardEl.style.width  = (PAD*2 + 7*CARD_W + 6*GAP) + "px";
  boardEl.style.height = (maxBottom + PAD) + "px";
  fitBoard();
  updateStatus();
  if (typeof saveGame === "function") saveGame();
  if (typeof scheduleWinProb === "function") scheduleWinProb();
}

function fitBoard(){
  const designW = PAD*2 + 7*CARD_W + 6*GAP;
  const avail = Math.min(window.innerWidth - 12, 1200);
  const scale = Math.min(1, avail / designW);
  G.scale = scale;
  boardEl.style.transform = `scale(${scale})`;
  document.getElementById("stage").style.height =
    (parseFloat(boardEl.style.height) * scale + 24) + "px";
}

/* ---------------------------------------------------------------- dealing -- */

function newGame(){
  if (typeof pickMode !== "undefined" && pickMode) clearPick();
  if (typeof sourceFlash !== "undefined" && sourceFlash) clearSourceFlash();
  boardEl.innerHTML = "";
  buildPiles();
  G.byId = {}; G.history = []; G.winShown = false;
  G.wandMode = false;
  G.turn3PassDone = false;
  G.passHadPlay = false;
  G.stuckNotified = false;
  G.winHistory = [];
  if (typeof resetWin === "function") resetWin();
  document.getElementById("drawThree").checked = true;   // every new game starts in turn-3
  document.getElementById("winOverlay").hidden = true;

  // pile bases
  eachPile(p => {
    const b = document.createElement("div");
    b.className = "pile-base" + (p.type === "stock" ? " stock" : "");
    const { x, y } = pileBaseXY(p);
    b.style.cssText = `left:0;top:0;width:${CARD_W}px;height:${CARD_H}px;transform:translate(${x}px,${y}px)`;
    if (p.type === "foundation") b.innerHTML = `<div class="glyph">${SYMBOL[p.index]}</div>`;
    if (p.type === "stock")      b.innerHTML = `<div class="glyph">⟳</div>`;
    p.el = b; boardEl.appendChild(b);
    // Dealing is handled by the board-level pointerdown handler (see wiring), so
    // it works anywhere that isn't a card — including the stock near the screen
    // edge, where a "click" would be eaten by the anti-swipe touch guard.
  });

  // deck
  const deck = [];
  let id = 0;
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++){
    const card = { id: id++, suit: s, rank: r, faceUp: false, el: null };
    card.el = document.createElement("div");
    card.el.dataset.id = card.id;
    card.el.addEventListener("pointerdown", onPointerDown);
    boardEl.appendChild(card.el);
    deck.push(card); G.byId[card.id] = card;
  }
  for (let i = deck.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  // deal tableau
  let k = 0;
  for (let col = 0; col < 7; col++){
    for (let n = 0; n <= col; n++){
      const card = deck[k++];
      card.faceUp = (n === col);
      G.piles.tableau[col].cards.push(card);
    }
  }
  while (k < deck.length){ const c = deck[k++]; c.faceUp = false; G.piles.stock.cards.push(c); }

  eachPile(p => p.cards.forEach(renderCard));
  layout();
}

/* -------------------------------------------------------------- undo state -- */

function snapshot(){
  const snap = { stock:[], waste:[], foundations:[[],[],[],[]], tableau:[[],[],[],[],[],[],[]] };
  G.piles.stock.cards.forEach(c => snap.stock.push([c.id, c.faceUp]));
  G.piles.waste.cards.forEach(c => snap.waste.push([c.id, c.faceUp]));
  G.piles.foundations.forEach((f,i) => f.cards.forEach(c => snap.foundations[i].push([c.id,c.faceUp])));
  G.piles.tableau.forEach((t,i) => t.cards.forEach(c => snap.tableau[i].push([c.id,c.faceUp])));
  return snap;
}
function pushHistory(){ G.history.push(snapshot()); if (G.history.length > 300) G.history.shift(); }
function applySnapshot(snap){
  const load = (pile, arr) => {
    pile.cards = arr.map(([id, up]) => { const c = G.byId[id]; c.faceUp = up; return c; });
  };
  load(G.piles.stock, snap.stock);
  load(G.piles.waste, snap.waste);
  snap.foundations.forEach((a,i) => load(G.piles.foundations[i], a));
  snap.tableau.forEach((a,i) => load(G.piles.tableau[i], a));
  eachPile(p => p.cards.forEach(renderCard));
  layout();
}

// Persist the in-progress game so closing/reloading/updating resumes seamlessly.
function saveGame(){
  try {
    const snap = snapshot();
    snap.draw3 = document.getElementById("drawThree").checked;
    snap.deck = currentDeck;
    snap.win = G.winHistory || [];
    localStorage.setItem("save", JSON.stringify(snap));
  } catch {}
}
function tryRestore(){
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem("save") || "null"); } catch {}
  if (!snap || !snap.tableau) return false;
  if ((snap.foundations || []).reduce((n,a) => n + a.length, 0) >= 52) return false; // finished game
  if (!forcedDeck && snap.deck && DECKS[snap.deck]) currentDeck = snap.deck;
  newGame();                                        // build card elements (its deal is overridden below)
  if (typeof snap.draw3 === "boolean") document.getElementById("drawThree").checked = snap.draw3;
  deckSel.value = currentDeck; updatePhoneMode();
  applySnapshot(snap);
  G.winHistory = Array.isArray(snap.win) ? snap.win : [];
  if (typeof drawWinChart === "function") drawWinChart();
  return true;
}
function undo(){
  cancelCycle();
  G.wandMode = false;
  if (!G.history.length) return;
  applySnapshot(G.history.pop());
}

/* -------------------------------------------------------------- stock draw -- */

// A little celebratory sparkle burst centered on an element. Options:
//   count — number of sparkles, dist — spread radius, small — tiny glyphs,
//   flash — also pulse a gold ring on the target (default true).
function sparkleBurst(target, opts){
  if (!target) return;
  const o = opts || {};
  const count = o.count || 9, near = o.dist || 26;
  const r = target.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const glyphs = ["✨","⭐","💫","✦"];
  for (let i = 0; i < count; i++){
    const s = document.createElement("div");
    s.className = "sparkle" + (o.small ? " small" : "");
    s.textContent = glyphs[i % glyphs.length];
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const dist = near + Math.random() * near;
    s.style.left = cx + "px"; s.style.top = cy + "px";
    s.style.setProperty("--dx", Math.cos(ang) * dist + "px");
    s.style.setProperty("--dy", Math.sin(ang) * dist + "px");
    s.style.animationDelay = Math.floor(Math.random() * 140) + "ms";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1200);
  }
  if (o.flash !== false){
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1000);
  }
}

// A small sparkle right where a card just landed on a legal destination.
function sparkleLand(pile){
  const c = topCard(pile);
  if (c && c.el) sparkleBurst(c.el, { small: true, count: 5, dist: 15, flash: false });
}

function drawFromStock(){
  cancelCycle();
  G.wandMode = false;                          // dealing hands the deck phase back to the player
  const stock = G.piles.stock, waste = G.piles.waste;
  pushHistory();
  if (stock.cards.length === 0){
    // A recycle means one full pass through the deck is done. If we were in
    // turn-3, that pass is over — drop to turn-1 (easier) for the rest of the
    // game, and sparkle the toggle so the player notices it flip off.
    // Only drop to turn-1 if the whole pass just made was fruitless — i.e. you
    // cycled the entire deck without being able to play a single card.
    const t3 = document.getElementById("drawThree");
    if (t3.checked && !G.turn3PassDone && !G.passHadPlay){
      G.turn3PassDone = true;
      t3.checked = false;
      sparkleBurst(document.getElementById("turn3label"));
    } else if (!t3.checked && !G.stuckNotified && isStuck()){
      // Already in turn-1 and there's genuinely nothing left to do → nudge New Game.
      G.stuckNotified = true;
      sparkleBurst(document.getElementById("newGame"));
    }
    G.passHadPlay = false;                     // a fresh pass through the deck begins
    // recycle waste -> stock
    while (waste.cards.length){
      const c = waste.cards.pop(); c.faceUp = false; renderCard(c); stock.cards.push(c);
    }
  } else {
    const n = document.getElementById("drawThree").checked ? 3 : 1;
    for (let i = 0; i < n && stock.cards.length; i++){
      const c = stock.cards.pop(); c.faceUp = true; renderCard(c); waste.cards.push(c);
    }
  }
  layout();
}

/* ---------------------------------------------------- find pile of a card -- */

function findCard(cardId){
  let res = null;
  eachPile(p => { const i = p.cards.findIndex(c => c.id == cardId); if (i >= 0) res = { pile:p, index:i }; });
  return res;
}

/* ------------------------------------------------------------- move commit -- */

// Move group (array of cards) from src pile to dst pile. Assumes legal.
function commitMove(group, src, dst){
  G.passHadPlay = true;                       // a real play happened this deck pass
  G.stuckNotified = false;                    // progress made — allow a future stuck nudge
  group.forEach(() => src.cards.pop());      // remove from end of src
  group.forEach(c => dst.cards.push(c));
  // flip newly exposed tableau card
  if (src.type === "tableau"){
    const t = topCard(src);
    if (t && !t.faceUp){ t.faceUp = true; renderCard(t); }
  }
}

/* ------------------------------------------------------- pointer dragging -- */

function boardPoint(e, rect, scale){
  const r = rect || boardEl.getBoundingClientRect();
  const s = scale || G.scale;
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}

function onPointerDown(e){
  if (e.button != null && e.button !== 0) return;
  if (G.drag) return;                      // one finger at a time — ignore extra touches
  cancelCycle();                           // touching a card stops the move-cycler
  const card = G.byId[e.currentTarget.dataset.id];
  const loc = findCard(card.id);
  if (!loc) return;
  const { pile, index } = loc;

  if (pile.type === "stock"){ drawFromStock(); return; }  // stock cards cover the base
  if (!card.faceUp) return;
  if (pile.type === "waste" && index !== pile.cards.length - 1) return;
  if (pile.type === "foundation" && index !== pile.cards.length - 1) return;

  const group = pile.cards.slice(index);             // this card + everything on top
  if (pile.type === "tableau" && !isValidRun(group)) return;

  // Cache the board rect/scale once per drag so pointermove never forces reflow.
  const rect = boardEl.getBoundingClientRect();
  const scale = G.scale;
  const pt = boardPoint(e, rect, scale);
  const lead = group[0];

  G.drag = {
    group, src: pile, lead, rect, scale, pointerId: e.pointerId,
    grabDX: pt.x - lead.home.x, grabDY: pt.y - lead.home.y,
    leadX: lead.home.x, leadY: lead.home.y,
    offsets: group.map(c => ({ c, dx: c.home.x - lead.home.x, dy: c.home.y - lead.home.y })),
    samples: [{ t: performance.now(), x: pt.x, y: pt.y }],
  };

  let zi = 2000;
  group.forEach(c => { c.el.classList.add("dragging"); c.el.style.zIndex = ++zi; });
  e.preventDefault();   // window-level move/up/cancel listeners (registered once) take it from here
}

function setGroupPos(drag, lx, ly){
  drag.leadX = lx; drag.leadY = ly;
  for (const o of drag.offsets) place(o.c, lx + o.dx, ly + o.dy);
}

function onPointerMove(e){
  const d = G.drag; if (!d || e.pointerId !== d.pointerId) return;
  const pt = boardPoint(e, d.rect, d.scale);
  setGroupPos(d, pt.x - d.grabDX, pt.y - d.grabDY);
  d.samples.push({ t: performance.now(), x: pt.x, y: pt.y });
  if (d.samples.length > 6) d.samples.shift();
}

function releaseVelocity(samples){
  if (samples.length < 2) return { vx:0, vy:0 };
  const a = samples[0], b = samples[samples.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return { vx:0, vy:0 };
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
}

function onPointerEnd(e){
  const d = G.drag; if (!d || e.pointerId !== d.pointerId) return;
  G.drag = null;
  d.group.forEach(c => c.el.classList.remove("dragging"));

  // Interrupted drag (touch cancel, context menu, etc.): just settle back home.
  if (e.type === "pointercancel"){
    animateGroup(d, d.lead.home.x, d.lead.home.y, 0, 0, () => layout());
    return;
  }

  const validTargets = [];
  eachPile(p => { if (p !== d.src && canDrop(d.group, p)) validTargets.push(p); });

  const { vx, vy } = releaseVelocity(d.samples);
  const speed = Math.hypot(vx, vy);

  // 1) Throw: pick the valid target best aligned with the release direction.
  let chosen = null;
  if (speed > THROW_SPEED && validTargets.length){
    let best = -2;
    for (const p of validTargets){
      const land = landingXY(p);
      const dx = land.x - d.leadX, dy = land.y - d.leadY;
      const dist = Math.hypot(dx, dy) || 1;
      const cos = (vx*dx + vy*dy) / (speed * dist);
      const score = cos - dist / 6000;           // prefer aligned, nearer
      if (cos > THROW_CONE && score > best){ best = score; chosen = p; }
    }
  }

  // 2) Otherwise drop on whatever valid pile the card overlaps most.
  if (!chosen){
    let bestArea = CARD_W * CARD_H * 0.18;
    const lr = { x: d.leadX, y: d.leadY };
    for (const p of validTargets){
      const land = landingXY(p);
      const ix = Math.max(0, Math.min(lr.x+CARD_W, land.x+CARD_W) - Math.max(lr.x, land.x));
      const iy = Math.max(0, Math.min(lr.y+CARD_H, land.y+CARD_H) - Math.max(lr.y, land.y));
      const area = ix * iy;
      if (area > bestArea){ bestArea = area; chosen = p; }
    }
  }

  if (chosen){
    G.wandMode = false;                          // a hand-dragged move is manual control
    pushHistory();
    const dst = chosen;
    commitMove(d.group, d.src, dst);
    const land = cardXY(dst, dst.cards.length - d.group.length);
    animateGroup(d, land.x, land.y, vx, vy, () => { layout(); sparkleLand(dst); afterMove(); });
    return;
  }

  // No drop from the drag. Was this really a TAP? (barely moved, quick.)
  const first = d.samples[0], lastS = d.samples[d.samples.length - 1];
  const movedPx = Math.hypot(lastS.x - first.x, lastS.y - first.y) * d.scale;  // screen px
  const now = performance.now();
  const isTap = movedPx < 12 && (now - first.t) < 350;

  // Tap-to-play: the tapped card jumps to its only legal move; if there's more
  // than one it lights every destination for a pick; if there's none it shakes.
  if (isTap){
    const targets = tapTargets(d.group, d.src);
    if (targets.length === 1){
      setGroupPos(d, d.lead.home.x, d.lead.home.y);   // undo the tiny drag jitter
      playCommit(d.group, d.src, targets[0]);
      return;
    }
    if (targets.length === 0){
      layout();                                       // snap home, then wiggle "no"
      shakeCards(d.group);
      return;
    }
    layout();                                         // snap home before ghosting
    enterPickMode(d.group, d.src, targets);
    return;
  }

  // A real (missed) drag: settle back home.
  G.wandMode = false;
  animateGroup(d, d.lead.home.x, d.lead.home.y, vx*0.25, vy*0.25, () => layout());
}

/* ----------------------------------------------------------- spring anim -- */

let animSeq = 0;
function animateGroup(drag, tx, ty, vx, vy, done, fast){
  // Tag every card in this group; if a newer animation claims any of them, this
  // loop bows out on its next frame — no two rAF loops ever fight over a card.
  const token = ++animSeq;
  drag.group.forEach(c => c.el._anim = token);
  const owns = () => drag.group.every(c => c.el._anim === token);

  const K = fast ? 560 : SPRING_K;     // fast: stiff, ~critically damped, zips home
  const D = fast ? 47  : SPRING_D;
  const cap = fast ? 350 : 1500;       // hard cap on loop lifetime

  let lx = drag.leadX, ly = drag.leadY;
  let vX = Math.max(-MAX_THROW_VEL, Math.min(MAX_THROW_VEL, vx));
  let vY = Math.max(-MAX_THROW_VEL, Math.min(MAX_THROW_VEL, vy));
  const start = performance.now();
  let last = start;

  function finish(){
    setGroupPos(drag, tx, ty);
    drag.group.forEach(c => { if (c.el._anim === token) c.el._anim = 0; });
    done && done();
  }
  function frame(now){
    if (!owns()) return;                       // superseded — stop cleanly
    let dt = (now - last) / 1000; last = now;
    if (dt > 0.032) dt = 0.032;
    const ax = K * (tx - lx) - D * vX;
    const ay = K * (ty - ly) - D * vY;
    vX += ax * dt; vY += ay * dt;
    lx += vX * dt; ly += vY * dt;
    setGroupPos(drag, lx, ly);
    const settled = Math.hypot(tx - lx, ty - ly) < 0.6 && Math.hypot(vX, vY) < 14;
    if (settled || now - start > cap){          // hard cap: never run forever
      finish();
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* --------------------------------------------------- double-click to play -- */

function findFoundationFor(card){
  return G.piles.foundations.find(f => canDropFoundation(card, f)) || null;
}

/* ------------------------------------------------------ autoplay & finish -- */

// "Safe" to auto-send to foundation without hurting tableau building.
function isSafe(card){
  if (card.rank <= 2) return true;
  const f = G.piles.foundations;
  const opp = colorOf(card.suit) === "red" ? "black" : "red";
  // both opposite-color foundations must be high enough that this card is never needed
  const oppPiles = f.map(p=>topCard(p)).filter(t=>t&&colorOf(t.suit)===opp).map(t=>t.rank);
  const oppMin = oppPiles.length === 2 ? Math.min(...oppPiles) : 0;
  return oppMin >= card.rank - 1;
}

function collectibleCards(force){
  const out = [];
  const consider = (pile) => {
    const c = topCard(pile); if (!c || !c.faceUp) return;
    const f = findFoundationFor(c);
    if (f && (force || isSafe(c))) out.push({ card:c, pile, f });
  };
  consider(G.piles.waste);
  G.piles.tableau.forEach(consider);
  return out;
}

function autoCollectStep(force){
  const list = collectibleCards(force);
  if (!list.length){ updateFinishButton(); checkWin(); return; }
  // Once the outcome is decided (or on Auto-finish), blast cards up fast and
  // overlapped instead of waiting for each one to settle.
  const fast = force || isAutoFinishable();
  const { card, pile, f } = list[0];
  pushHistory();
  const drag = { group:[card], lead:card, leadX:card.home.x, leadY:card.home.y,
                 offsets:[{c:card,dx:0,dy:0}] };
  commitMove([card], pile, f);
  const land = cardXY(f, f.cards.length - 1);
  card.el.style.zIndex = 3000 + f.cards.length;
  if (fast){
    animateGroup(drag, land.x, land.y, 0, 0, () => { layout(); sparkleLand(f); }, true);
    setTimeout(() => autoCollectStep(force), 55);      // stagger next while this flies
  } else {
    animateGroup(drag, land.x, land.y, 0, 0, () => { layout(); sparkleLand(f); autoCollectStep(force); });
  }
}

function afterMove(){
  updateFinishButton();
  // In a wand session, picking an offered move resumes the cascade (it does its
  // own safe-collecting, so skip the separate autoplay sweep).
  if (G.wandMode){ wandCascade(); return; }
  if (document.getElementById("autoplay").checked) autoCollectStep(false);
  else checkWin();
}

function isAutoFinishable(){
  if (G.piles.stock.cards.length || G.piles.waste.cards.length) return false;
  return G.piles.tableau.every(t => t.cards.every(c => c.faceUp));
}
function updateFinishButton(){
  document.getElementById("finish").hidden = !isAutoFinishable() || isWon();
}

/* ----------------------------------------------------------------- win -- */

function isWon(){
  return G.piles.foundations.length === 4 &&
         G.piles.foundations.every(f => f.cards.length === 13);
}
function checkWin(){ if (isWon() && !G.winShown){ G.winShown = true; showWin(); } }

function updateStatus(){
  if (typeof updateMoveButton === "function") updateMoveButton();   // deal-vs-wand state + turn-3/1 art
  const f = G.piles.foundations.reduce((n,p)=>n+p.cards.length,0);
  document.getElementById("status").textContent = `Foundations: ${f}/52`;
}

// Resolve to a loaded <img>, or reject — but never hang (hard timeout).
function loadImage(url, ms){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => { img.src = ""; reject(new Error("timeout")); }, ms);
    img.onload  = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("error")); };
    img.src = url;
  });
}

const rnd = () => Math.floor(Math.random() * 1e9);
const pick = a => a[Math.floor(Math.random() * a.length)];
// LoremFlickr: random CC photo by keyword. The trailing ?random= busts the
// browser cache so each win pulls a fresh image.
function flickrUrl(tags){
  const [w, h] = WIN_IMAGE.size;
  return `https://loremflickr.com/${w}/${h}/${encodeURIComponent(tags)}?random=${rnd()}`;
}
function picsumUrl(){
  const [w, h] = WIN_IMAGE.size;
  return `https://picsum.photos/seed/${rnd()}/${w}/${h}`;
}

// Test hooks:  ?prize  or ?prize=1 forces the glamour route, ?prize=0 forces a
// plain random photo;  ?win  pops the win screen immediately (no need to win).
const PARAMS = new URLSearchParams(location.search);

// Build the candidate list: themed source first, then independent fallbacks so a
// hiccup on one host still yields a picture.
function winCandidates(){
  // Choose the tag pool: puppies on iPad/iPhone, else glamour/random by the odds.
  let pool;
  if (IS_APPLE_TOUCH && !PARAMS.has("nopups")){
    pool = WIN_IMAGE.puppyTags;
  } else {
    const forced = PARAMS.get("prize");
    const prize = forced !== null ? forced !== "0" : Math.random() < WIN_IMAGE.prizeOdds;
    pool = prize ? WIN_IMAGE.prizeTags : WIN_IMAGE.randomTags;
  }
  // Each candidate re-picks a single tag, so a fallback also uses a fresh tag.
  return [
    [flickrUrl(pick(pool)), ""],
    [flickrUrl(pick(pool)), ""],
    [picsumUrl(),           ""],
  ];
}

async function showWin(){
  const overlay = document.getElementById("winOverlay");
  const wrap = document.getElementById("winImageWrap");
  const cap  = document.getElementById("winCaption");
  overlay.hidden = false;
  wrap.innerHTML = '<div class="spinner"></div>';
  cap.textContent = "";
  drawFinalWinChart();                                 // recap the odds swing (if tracked)
  try { localStorage.removeItem("save"); } catch {}   // finished game — don't resume it

  for (const [url, label] of winCandidates()){
    try {
      const img = await loadImage(url, 9000);
      img.draggable = false;
      wrap.innerHTML = ""; wrap.appendChild(img);
      cap.textContent = label;
      return;
    } catch { /* try next source */ }
  }
  wrap.innerHTML = '<div style="padding:2rem;opacity:.7">🏆<br>(couldn\'t reach the photo sources this time)</div>';
}

/* ---------------------------------------------------------------- wiring -- */

// Drag listeners are registered ONCE here (not per-drag) and no-op when idle —
// so they can never accumulate or leak across drags/games.
window.addEventListener("pointermove", onPointerMove);
window.addEventListener("pointerup", onPointerEnd);
window.addEventListener("pointercancel", onPointerEnd);

// While a tapped card's destinations are flashing, the very next touch resolves
// the pick. Capture phase so this beats any card's own handler: a touch on a
// flashing destination plays there; a touch on the card being moved is let
// through so it can be picked up and tossed; a toolbar control just cancels; and
// anything else cancels.
window.addEventListener("pointerdown", (e) => {
  if (!pickMode) return;
  if (e.target.closest && e.target.closest("#toolbar, .fab, #installBanner, #winOverlay")){
    clearPick(); return;
  }
  // Touching the card being decided: drop the hint and let the normal drag start,
  // so the player can toss the card to a destination instead of tapping it.
  const cardEl = e.target.closest && e.target.closest(".card");
  if (cardEl && pickMode.group.some(c => c.el === cardEl)){ clearPick(); return; }
  resolvePick(boardPoint(e));
  e.preventDefault();
  e.stopPropagation();
}, true);

// A TAP on bare felt (no card) runs the combo action — the whole board is a big,
// forgiving hit target for the deck. But a DRAG on the felt is ignored (it must
// not scroll the page or fire the button): remember the down point and only act
// if the finger barely moved. Cards keep their own handler; pick-mode taps are
// consumed above before they reach here.
let feltTap = null;
boardEl.addEventListener("pointerdown", (e) => {
  feltTap = null;
  if (pickMode || G.drag) return;              // a pick or drag is in progress
  if (e.button != null && e.button !== 0) return;
  if (e.target.closest && e.target.closest(".card")) return;   // a real card → let it handle itself
  feltTap = { x: e.clientX, y: e.clientY, id: e.pointerId, t: performance.now() };
});
window.addEventListener("pointerup", (e) => {
  if (!feltTap || e.pointerId !== feltTap.id) return;
  const moved = Math.hypot(e.clientX - feltTap.x, e.clientY - feltTap.y);
  const quick = performance.now() - feltTap.t < 500;
  feltTap = null;
  if (moved < 12 && quick) moveButtonTap();     // a genuine tap, not a drag
});

// iOS turns stray one-finger drags (on the felt, the wand button, empty space)
// into page scroll / pull-to-refresh — pointless no-ops in a fixed board game.
// Swallow them. Cards drive their own drags through pointer events (with
// touch-action:none), so those keep working; the toolbar and popups still scroll.
document.addEventListener("touchmove", (e) => {
  if (e.touches.length !== 1) return;                        // let pinch-zoom through
  if (e.target.closest && e.target.closest("#toolbar, #winOverlay, #installBanner")) return;
  e.preventDefault();
}, { passive: false });

// Also kill iOS's edge swipe (back/forward navigation) at touchstart, so a drag
// begun in the screen-edge strip can't yank you off the page.
const EDGE_GUARD = 26;
document.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  const x = e.touches[0].clientX;
  if (x > EDGE_GUARD && x < window.innerWidth - EDGE_GUARD) return;   // not near an edge
  if (e.target.closest && e.target.closest("#toolbar")) return;       // leave controls alone
  e.preventDefault();                                                 // suppress the swipe gesture
}, { passive: false });

/* --------------------------------------------------- legal-move enumeration -- */
// Shared move-finding used by the Wand (auto-play), the stuck detector, and the
// tap-to-play picker below.
let pickMode = null;     // tap-to-play: a card's destinations are flashing, awaiting the pick
let sourceFlash = null;  // wand decision: the playable cards are flashing, awaiting a pick
let wandRunning = false, wandCount = 0;   // auto-play cascade state (+ runaway guard)

const pileTopEl = p => (p.cards.length ? p.cards[p.cards.length - 1].el : p.el);

function legalTargets(group, from){
  const ts = [];
  let emptyFoundationAdded = false;
  G.piles.foundations.forEach(f => {
    if (f === from || !canDrop(group, f)) return;
    if (f.cards.length === 0){ if (emptyFoundationAdded) return; emptyFoundationAdded = true; } // empties are equivalent
    ts.push(f);
  });
  let emptyColAdded = false;
  G.piles.tableau.forEach(t => {
    if (t === from || !canDrop(group, t)) return;
    if (t.cards.length === 0){ if (emptyColAdded) return; emptyColAdded = true; }  // empty columns are equivalent
    ts.push(t);
  });
  return ts;
}

// Would keeping `card` on the tableau (rather than sending it to a foundation)
// let some OTHER buried run relocate onto it and expose a face-down card? That's
// the one case where "just send it up" would cost you a reveal — worth a choice.
function tapKeepRevealsCard(card, from){
  const need = card.rank - 1;
  if (need < 1) return false;                         // nothing sits below an Ace
  for (const p of G.piles.tableau){
    if (p === from) continue;
    const f = p.cards.findIndex(c => c.faceUp);
    if (f <= 0) continue;                             // no face-down card beneath the run
    const run = p.cards.slice(f);
    if (!isValidRun(run)) continue;
    const lead = run[0];
    if (lead.rank === need && colorOf(lead.suit) !== colorOf(card.suit)) return true;
  }
  return false;
}

// The destinations to offer when a card is TAPPED (vs. dragged). Trims the raw
// legal moves down to real decisions so the player is only asked to pick when it
// actually matters:
//   • interchangeable tableau columns collapse to one (same landing either way);
//   • a foundation ("the top") is taken automatically when it's safe or when
//     keeping the card on the tableau wouldn't buy a reveal;
//   • only a genuine top-vs-reveal fork is handed back as a multi-choice pick.
function tapTargets(group, from){
  const raw = legalTargets(group, from);
  if (raw.length <= 1) return raw;                    // 0 → shake, 1 → just play it
  const card = group[0];
  const foundation = raw.find(t => t.type === "foundation") || null;
  const tableau =
    raw.find(t => t.type === "tableau" && t.cards.length > 0) ||  // any non-empty (all equal)
    raw.find(t => t.type === "tableau") || null;                  // else an empty column
  if (foundation && tableau){
    if (isSafe(card)) return [foundation];            // it'd auto-play up anyway → top
    return tapKeepRevealsCard(card, from) ? [foundation, tableau] : [foundation];
  }
  if (foundation) return [foundation];
  return tableau ? [tableau] : raw;                   // tableau-only → one, no prompt
}

function moveableCards(){
  const out = [];
  const w = topCard(G.piles.waste);
  if (w){ const ts = legalTargets([w], G.piles.waste); if (ts.length) out.push({ group:[w], from:G.piles.waste, targets:ts }); }
  G.piles.tableau.forEach(p => {
    for (let i = 0; i < p.cards.length; i++){
      const c = p.cards[i];
      if (!c.faceUp) continue;
      const group = p.cards.slice(i);
      if (!isValidRun(group)) continue;
      // Keep foundation moves, and only tableau moves that ACCOMPLISH something:
      // reveal a face-down card, or empty this column. Drop pure lateral shuffles
      // (moving a face-up run onto another stack with nothing gained).
      const exposesDown = i > 0 && !p.cards[i - 1].faceUp;
      const ts = legalTargets(group, p).filter(t => {
        if (t.type !== "tableau") return true;             // → foundation: always productive
        if (exposesDown) return true;                      // reveals a face-down card
        if (i === 0) return t.cards.length > 0;            // empties this column onto another pile
        return false;                                      // sub-run shuffle over a face-up card: pointless
      });
      if (ts.length) out.push({ group, from:p, targets:ts });
    }
  });
  return out;
}

function makeDrag(group){
  const lead = group[0];
  return { group, lead, leadX: lead.home.x, leadY: lead.home.y,
    offsets: group.map(c => ({ c, dx: c.home.x - lead.home.x, dy: c.home.y - lead.home.y })) };
}

function playCommit(group, from, to, drag){
  pushHistory();
  let z = 2600; group.forEach(c => c.el.style.zIndex = ++z);
  commitMove(group, from, to);
  const land = cardXY(to, to.cards.length - group.length);
  animateGroup(drag || makeDrag(group), land.x, land.y, 0, 0, () => { layout(); sparkleLand(to); afterMove(); });
}

// Flat list of every legal move on the board (foundation moves first).
function buildMoves(){
  const moves = [];
  moveableCards().forEach(m => m.targets.forEach(to => moves.push({ group: m.group, from: m.from, to })));
  return moves;
}

// Stuck = no PRODUCTIVE move remains. If there's a productive play the player
// simply hasn't made — a real board move, or any stock/waste card still playable
// (incl. one they skipped while going through the deck) — the game isn't over,
// so we stay quiet. Pointless lateral shuffles don't count as productive.
function isStuck(){
  if (buildMoves().length) return false;                 // a productive board move is available
  const deck = G.piles.stock.cards.concat(G.piles.waste.cards);
  return !deck.some(c =>                                  // any deck card still playable somewhere
    G.piles.foundations.some(f => canDropFoundation(c, f)) ||
    G.piles.tableau.some(t => canDropTableau(c, t)));
}

function cancelCycle(){ clearPick(); clearSourceFlash(); cancelWand(); } // external interrupts (deal/drag/undo)

/* -------------------------------------------------- tap-to-play (pick mode) -- */
// Tapping a card auto-plays it. With several legal destinations we can't guess
// which one, so we light every landing spot with a translucent ghost + gold glow
// and wait: the next touch on a lit spot plays there, anywhere else cancels.

function shakeCards(cards){
  cards.forEach(card => {
    const { x, y } = card.home;
    card.el.animate([
      { transform:`translate(${x}px,${y}px)` },
      { transform:`translate(${x-7}px,${y}px)` },
      { transform:`translate(${x+7}px,${y}px)` },
      { transform:`translate(${x-4}px,${y}px)` },
      { transform:`translate(${x}px,${y}px)` },
    ], { duration: 300, easing: "ease-in-out" });
  });
}

// A tapped card can go several places: flash each destination gold and lean the
// card part-way toward each in turn, so the choice of where to send it reads the
// same as a multi-card choice. Tap a destination (or toss the card there); a tap
// anywhere else cancels.
function enterPickMode(group, from, targets){
  clearPick(); clearSourceFlash();
  const lead = group[0];
  const lastOff = group[group.length - 1].home.y - lead.home.y;
  const spots = [], flashed = [], wig = [], saved = [];
  targets.forEach(to => {
    const base = cardXY(to, to.cards.length);           // where the lead would land
    const el = pileTopEl(to);
    el.classList.add("flash-dst"); flashed.push(el);
    spots.push({ to, x: base.x, y: base.y, w: CARD_W, h: CARD_H + lastOff });
    wig.push({ lead, group, base: { x: lead.home.x, y: lead.home.y }, target: { x: base.x, y: base.y } });
  });
  lead.el.classList.add("flash-src"); flashed.push(lead.el);   // the card that will move
  group.forEach((c, gi) => {                             // lift the run so its lean reads clearly
    saved.push({ el: c.el, tx: c.el.style.transform, z: c.el.style.zIndex });
    c.el.style.zIndex = 4500 + gi;
  });
  pickMode = { group, from, spots, flashed, wig, saved };
  startWiggle(pickMode);
}

function clearPick(){
  if (!pickMode) return;
  pickMode.flashed.forEach(el => el.classList.remove("flash-dst", "flash-src"));
  (pickMode.saved || []).forEach(s => { s.el.style.transform = s.tx; s.el.style.zIndex = s.z; });
  pickMode = null;                                       // stops its wiggle (startWiggle checks this)
}

// A touch while destinations are flashing: play to the spot under it, else cancel.
// (Touches on the card itself are handled upstream so it can be dragged/tossed.)
function resolvePick(pt){
  const pm = pickMode;
  clearPick();
  if (!pm) return;
  for (const s of pm.spots){
    if (pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h){
      playCommit(pm.group, pm.from, s.to);
      return;
    }
  }
  // tapped somewhere else → just cancel
}

/* --------------------------------------------- combo button: deal ↔ auto-play -- */
// One button. When a productive move exists it goes GOLD with a wand and, on tap,
// auto-plays the obvious/forced moves in a cascade — pausing at a genuine fork to
// let YOU decide (a cycling ghost, below). When nothing's playable it goes GREEN
// with the deck art (three fanned cards in turn-3, one in turn-1) and draws stock.
const WAND_HTML = "🪄";

function moveButtonTap(){
  if (wandRunning) return;                   // a cascade is already running
  if (sourceFlash){ intensifyFlash(); return; }    // choices are glowing → make them pop, "pick one"
  if (pickMode){ clearPick(); return; }            // destinations showing → dismiss the hint
  if (wandActionable()) wandCascade();             // tableau work to do → let the wand play/flash
  else drawFromStock();                            // only deck/foundation moves left → deal
}

// Hitting the wand while the choices glow gives them a brief, stronger pulse so
// it's obvious the game is waiting for you to pick one of them.
function intensifyFlash(){
  if (!sourceFlash) return;
  sourceFlash.els.forEach(el => el.classList.add("flash-strong"));
  clearTimeout(sourceFlash.strongTimer);
  sourceFlash.strongTimer = setTimeout(() => {
    if (sourceFlash) sourceFlash.els.forEach(el => el.classList.remove("flash-strong"));
  }, 1000);
}

// Auto-play forced/safe moves until only a real decision (or nothing) is left.
// G.wandMode marks a live wand session: it stays set while a decision waits, so
// resolving the decision resumes the cascade (see afterMove).
function wandCascade(){
  if (wandRunning) return;
  G.wandMode = true;
  wandRunning = true; wandCount = 0;
  updateMoveButton();
  wandStep();
}
function endWand(){ wandRunning = false; G.wandMode = false; }
function cancelWand(){ wandRunning = false; }

// Every productive move the wand should handle — tableau AND waste (playing a
// card off the waste is a real move; it's how you expose the next deck card).
function wandSources(){
  const src = [];
  moveableCards().forEach(s => {
    const tt = tapTargets(s.group, s.from);
    if (tt.length) src.push({ group: s.group, from: s.from, tt, lead: s.group[0] });
  });
  return src;
}
// Does the wand have a move to make (button gold), or is dealing the only option
// left (button green)?
function wandActionable(){
  if (!(G.piles && G.piles.tableau)) return false;
  return !!safeCollectMove() || wandSources().length > 0;
}

function wandStep(){
  if (!wandRunning) return;
  if (++wandCount > 400){ endWand(); updateMoveButton(); return; }   // runaway guard
  // 0) Endgame (everything face-up, deck done): blast it home like Auto-finish.
  if (isAutoFinishable()){ endWand(); updateMoveButton(); autoCollectStep(true); return; }
  // 1) Obvious: sweep safe cards up to the foundations.
  const safe = safeCollectMove();
  if (safe){ cascadeMove(safe); return; }
  // 2) Tableau moves, each reduced to its real decision via tapTargets.
  const src = wandSources();
  if (src.length === 0){ endWand(); checkWin(); updateFinishButton(); updateMoveButton(); return; }
  // 3) Auto-play a single-destination move that nothing else competes for — these
  //    are order-independent (6→7 and 7→8, in any order, reach the same board), so
  //    just do them; the cascade re-evaluates and clears the rest one by one.
  const singles = src.filter(m => m.tt.length === 1);
  const demand = new Map();
  singles.forEach(m => { const k = m.tt[0].type + "#" + m.tt[0].index; demand.set(k, (demand.get(k) || 0) + 1); });
  const free = singles.find(m => demand.get(m.tt[0].type + "#" + m.tt[0].index) === 1);
  if (free){ cascadeMove({ group: free.group, from: free.from, to: free.tt[0] }); return; }
  // 4) Only genuine choices remain — a card with several destinations, or cards
  //    competing for one spot. Flash them and let the player decide.
  wandRunning = false;
  const seen = new Set(), leads = [];
  src.forEach(m => { if (!seen.has(m.lead.id)){ seen.add(m.lead.id); leads.push(m.lead); } });
  if (leads.length === 1 && src[0].tt.length > 1) enterPickMode(src[0].group, src[0].from, src[0].tt);  // one card, choose where
  else enterSourceFlash(leads);                                                                          // choose which card
  updateMoveButton();
}

// Auto-play a move: briefly glow the card gold (so a lone play shows the same
// golden cue as a choice does), then fly it home and continue the cascade.
function cascadeMove(m){
  const lead = m.group[0];
  lead.el.classList.add("flash-src");                 // "here's the card I'm playing"
  setTimeout(() => {
    if (!wandRunning){ lead.el.classList.remove("flash-src"); return; }  // cancelled mid-glow
    pushHistory();
    let z = 2600; m.group.forEach(c => c.el.style.zIndex = ++z);
    commitMove(m.group, m.from, m.to);
    const land = cardXY(m.to, m.to.cards.length - m.group.length);
    animateGroup(makeDrag(m.group), land.x, land.y, 0, 0,
      () => { lead.el.classList.remove("flash-src"); layout(); sparkleLand(m.to); wandStep(); }, true);
  }, 200);
}

// A safe foundation collect (one that never hurts tableau building), or null.
function safeCollectMove(){
  const consider = (pile) => {
    const c = topCard(pile); if (!c || !c.faceUp) return null;
    const f = findFoundationFor(c);
    return (f && isSafe(c)) ? { group:[c], from:pile, to:f } : null;
  };
  let m = consider(G.piles.waste); if (m) return m;
  for (const t of G.piles.tableau){ m = consider(t); if (m) return m; }
  return null;
}

/* ------------------------------------------------ flash the choices at a decision -- */
// Several genuinely different cards can be played (which pile to reveal, which
// King to move, …). Flash each playable card gold, and — since the whole point of
// the choice is usually what you'd uncover — peek the face-down card each play
// would flip up, so you can see both outcomes before deciding (like playing one,
// looking, undoing, and trying the other). Tapping a card (or its peek) plays it.
const PEEK_SHIFT = 68;   // how far a movable card slides down to reveal the peek

function enterSourceFlash(leads){
  clearPick(); clearSourceFlash();
  const peeks = [], saved = [], wig = [];
  leads.forEach(lead => {
    lead.el.classList.add("flash-src");
    const loc = findCard(lead.id);
    if (!loc) return;
    const group = loc.pile.cards.slice(loc.index);
    let baseDY = 0;
    // If this play uncovers a face-down card, show a half-size preview of it in
    // its real spot and slide the movable card(s) down below it.
    if (loc.pile.type === "tableau" && loc.index > 0){
      const under = loc.pile.cards[loc.index - 1];
      if (under && !under.faceUp){ peeks.push(makePeek(under, lead)); baseDY = PEEK_SHIFT; }
    }
    // Lift the group's cards to the front (so their wiggle reads clearly) and set
    // their resting position (slid down a touch when a peek sits above them).
    group.forEach((c, gi) => {
      saved.push({ el: c.el, tx: c.el.style.transform, z: c.el.style.zIndex });
      c.el.style.zIndex = 4500 + gi;
      c.el.style.transform = `translate(${c.home.x}px,${c.home.y + baseDY}px)`;
    });
    const tt = tapTargets(group, loc.pile);            // where this play would land
    const land = tt.length ? cardXY(tt[0], tt[0].cards.length) : { x: lead.home.x, y: lead.home.y };
    wig.push({ lead, group, base: { x: lead.home.x, y: lead.home.y + baseDY }, target: land });
  });
  sourceFlash = { els: leads.map(l => l.el), peeks, saved, wig };
  startWiggle(sourceFlash);
}

// Alternately ease each option a little way toward where it would go, so it's
// clear these are moves waiting to be picked. Subtle, one at a time. Works for a
// list of different cards (each toward its target) AND for one card leaning toward
// several targets — options may share a group, so we reset then move the active.
function startWiggle(state){
  const AMP = 0.18, OUT = 480, HOLD = 240, IN = 420, GAP = 220;   // ms per phase
  const cycle = OUT + HOLD + IN + GAP;
  const smooth = u => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
  const place = (it, dx, dy) => it.group.forEach(c => {
    const ox = c.home.x - it.lead.home.x, oy = c.home.y - it.lead.home.y;
    c.el.style.transform = `translate(${it.base.x + dx + ox}px,${it.base.y + dy + oy}px)`;
  });
  const start = performance.now();
  const frame = (now) => {
    if ((sourceFlash || pickMode) !== state) return;   // superseded or cleared
    const wig = state.wig; if (!wig.length) return;
    const t = now - start, active = Math.floor(t / cycle) % wig.length, local = t % cycle;
    let f = 0;   // 0..1 within the current lean
    if (local < OUT) f = smooth(local / OUT);
    else if (local < OUT + HOLD) f = 1;
    else if (local < OUT + HOLD + IN) f = 1 - smooth((local - OUT - HOLD) / IN);
    wig.forEach(it => place(it, 0, 0));                 // everything rests at its base
    if (f > 0){                                          // then the active option leans out
      const it = wig[active];
      const rx = it.target.x - it.base.x, ry = it.target.y - it.base.y;
      const dist = Math.hypot(rx, ry) || 1;
      const mag = f * Math.min(AMP * dist, 55);          // part-way, but never a big lurch
      place(it, rx / dist * mag, ry / dist * mag);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function clearSourceFlash(){
  if (!sourceFlash) return;
  clearTimeout(sourceFlash.strongTimer);
  sourceFlash.els.forEach(el => el.classList.remove("flash-src", "flash-strong"));
  (sourceFlash.peeks || []).forEach(el => el.remove());
  (sourceFlash.saved || []).forEach(s => { s.el.style.transform = s.tx; s.el.style.zIndex = s.z; });
  sourceFlash = null;                                    // stops its wiggle (startWiggle checks this)
}

// A half-size, face-up preview of the card a play would flip up, drawn in that
// card's real spot so it reads as a preview (not a real card on the stack).
function makePeek(hidden, lead){
  const el = document.createElement("div");
  el.className = `card face ${colorOf(hidden.suit)} peek`;
  el.style.width = CARD_W + "px"; el.style.height = CARD_H + "px";
  if (DECKS[currentDeck].type === "phone"){
    el.innerHTML = phoneCardSVG(hidden);
  } else {
    const img = new Image();
    img.draggable = false;
    img.alt = `${RANKS[hidden.rank]}${SYMBOL[hidden.suit]}`;
    img.onerror = () => { el.innerHTML = textFace(hidden); };
    img.src = cardFile(hidden);
    el.appendChild(img);
  }
  const { x, y } = hidden.home;                         // its real spot, centered, half size
  el.style.transformOrigin = "top left";
  el.style.transform = `translate(${x + CARD_W * 0.25}px,${y}px) scale(.5)`;
  el.style.zIndex = 4400;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault(); e.stopPropagation();
    clearSourceFlash();
    playSourceCard(lead);
  });
  boardEl.appendChild(el);
  return el;
}

// Play a specific card the same way tapping it would (used by peeks). Reveals a
// destination pick if the card itself still has a real choice of where to go.
function playSourceCard(card){
  const loc = findCard(card.id);
  if (!loc) return;
  const group = loc.pile.cards.slice(loc.index);
  const targets = tapTargets(group, loc.pile);
  if (targets.length === 1) playCommit(group, loc.pile, targets[0]);
  else if (targets.length === 0){ layout(); shakeCards(group); }
  else enterPickMode(group, loc.pile, targets);
}

/* -------------------------------------------------------- deal-button artwork -- */
function dealIconSVG(three){
  const back = (rot) =>
    `<g transform="rotate(${rot} 0 16)">` +
      `<rect x="-8.5" y="-12.5" width="17" height="25" rx="3" fill="#1d4ed8" stroke="#fff" stroke-width="2"/>` +
      `<rect x="-5.5" y="-9.5" width="11" height="19" rx="2" fill="none" stroke="#ffffff88" stroke-width="1.3"/>` +
    `</g>`;
  const inner = three ? back(-18) + back(0) + back(18) : back(0);
  return `<svg viewBox="-24 -20 48 40" width="38" height="32" aria-hidden="true">${inner}</svg>`;
}
const RECYCLE_HTML = `<span style="font-size:34px;line-height:1">⟳</span>`;
function updateMoveButton(){
  const el = document.getElementById("dealFab");
  if (!el) return;
  const dealt = !!(G.piles && G.piles.tableau);     // piles may not exist at first wiring
  const wandMode = wandRunning || !!sourceFlash || (dealt && wandActionable());
  el.classList.toggle("wand", wandMode);
  if (wandMode){
    if (el._mode !== "wand"){ el.innerHTML = WAND_HTML; el._mode = "wand"; }
  } else if (dealt && G.piles.stock.cards.length === 0){
    // Stock's spent: the next tap RECYCLES the waste (flips it face-down back to
    // the stock), so show a recycle glyph — not the deal fan — to make that clear.
    if (el._mode !== "recycle"){ el.innerHTML = RECYCLE_HTML; el._mode = "recycle"; }
  } else {
    const three = document.getElementById("drawThree").checked;
    const key = three ? "d3" : "d1";
    if (el._mode !== key){ el.innerHTML = dealIconSVG(three); el._mode = key; }
  }
}

/* ---------------------------------------------------------------- wiring -- */

document.getElementById("newGame").addEventListener("click", startGame);
document.getElementById("winNew").addEventListener("click", startGame);
document.getElementById("undo").addEventListener("click", undo);
document.getElementById("finish").addEventListener("click", () => autoCollectStep(true));
window.addEventListener("resize", () => { fitBoard();
  document.getElementById("stage").style.height =
    (parseFloat(boardEl.style.height) * G.scale + 24) + "px"; });

// localStorage throws in Safari Private mode — never let that break the game.
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// Deck picker — remember the choice and re-skin cards live (no re-deal).
// On a phone-sized screen (not iPad) default to the big-rank Phone deck.
const IS_PHONE_SCREEN = Math.min(screen.width, screen.height) <= 480;
const deckSel = document.getElementById("deck");
const forcedDeck = PARAMS.get("deck");
const savedDeck = lsGet("deck");
if (forcedDeck && DECKS[forcedDeck]) currentDeck = forcedDeck;   // ?deck=phone|knoll|fomin
else if (savedDeck && DECKS[savedDeck]) currentDeck = savedDeck;
else if (IS_PHONE_SCREEN) currentDeck = "phone";
deckSel.value = currentDeck;

// "Phone mode" (Phone deck): show the thumb-reach combo button. Fire on pointerup
// (with touch-action:none) so a touch that jiggles a little still taps the button
// instead of being read as a page scroll.
const dealFab = document.getElementById("dealFab");
dealFab.addEventListener("pointerup", (e) => { if (e.button == null || e.button === 0) moveButtonTap(); });
document.getElementById("drawThree").addEventListener("change", updateMoveButton);
updateMoveButton();                                  // initial button state + art
const updatePhoneMode = () =>
  document.body.classList.toggle("phone-mode", currentDeck === "phone");
updatePhoneMode();

deckSel.addEventListener("change", () => {
  cancelCycle();
  currentDeck = deckSel.value;
  lsSet("deck", currentDeck);
  updatePhoneMode();
  eachPile(p => p.cards.forEach(renderCard));
  layout();
});

/* ---------------------------------------------------- PWA: install + offline -- */

// Register the service worker (offline play) and keep the app up to date: each
// deploy is a new SW, and when it takes control we reload once to pick up the
// latest code. The in-progress game is saved, so the reload is seamless — this
// fixes the "home-screen app shows an old version" problem on iOS.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;   // don't reload on the very first install
    reloading = true;
    location.reload();
  });
  const checkForUpdate = () =>
    navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").then(checkForUpdate).catch(() => {}));
  document.addEventListener("visibilitychange", () => {   // re-check when the app is reopened
    if (document.visibilityState === "visible") checkForUpdate();
  });
}

let deferredInstall = null;
const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // iPadOS reports as Mac

const installBanner = document.getElementById("installBanner");
const installBtn = document.getElementById("installBtn");
const installMsg = document.getElementById("installMsg");

// Chrome/Android: stash the prompt so we can trigger it from our own button.
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  maybeShowInstall(parseInt(lsGet("games") || "0", 10));
});
window.addEventListener("appinstalled", () => { installBanner.hidden = true; lsSet("installDismissed", "1"); });

document.getElementById("installClose").addEventListener("click", () => {
  installBanner.hidden = true; lsSet("installDismissed", "1");
});
installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch {}
  deferredInstall = null;
  installBanner.hidden = true; lsSet("installDismissed", "1");
});

// Offer to install only once the player has come back for a 2nd+ game.
function maybeShowInstall(games){
  if (isStandalone() || lsGet("installDismissed") || (games || 0) < 2) return;
  if (deferredInstall){                                   // Android/Chrome: real button
    installMsg.textContent = "Install Solitaire for full-screen, offline play?";
    installBtn.hidden = false;
    installBanner.hidden = false;
  } else if (isIOS()){                                    // iOS: manual, so show how
    installMsg.innerHTML = "Add to your Home Screen: tap <b>Share</b> → <b>Add to Home Screen</b> (plays offline).";
    installBtn.hidden = true;
    installBanner.hidden = false;
  }
}

// Every game start bumps the counter and reconsiders the install offer.
function startGame(){
  newGame();
  const n = (parseInt(lsGet("games") || "0", 10) || 0) + 1;
  lsSet("games", String(n));
  maybeShowInstall(n);
}

/* ----------------------------------------------------- win-probability chart -- */
// Estimate the position's win chance in a Web Worker (determinized greedy
// rollouts) and plot it as a strip: expected line + optimistic/pessimistic band.
let winWorker = null, winSeq = 0, lastPub = "", winTimer = 0;
const winCanvas = document.getElementById("winchart");
const oddsToggle = document.getElementById("oddsToggle");
const oddsOn = () => oddsToggle.checked;
try { winWorker = new Worker("winprob.worker.js"); } catch { winWorker = null; }
if (winWorker){
  winWorker.onerror = () => { winWorker = null; drawWinChart(); };   // worker unavailable → no chart
  winWorker.onmessage = (e) => {
    if (e.data.id !== winSeq) return;                  // ignore stale results
    (G.winHistory = G.winHistory || []).push({ low: e.data.low, mid: e.data.mid, high: e.data.high });
    if (G.winHistory.length > 400) G.winHistory.shift();
    drawWinChart();
  };
}

function winPub(){
  const found = [[],[],[],[]];
  G.piles.foundations.forEach(p => p.cards.forEach(c => found[c.suit].push(c.id)));
  return {
    draw: document.getElementById("drawThree").checked ? 3 : 1,
    up:   G.piles.tableau.map(t => t.cards.filter(c => c.faceUp).map(c => c.id)),
    waste: G.piles.waste.cards.map(c => c.id),
    found,
    down: G.piles.tableau.map(t => t.cards.filter(c => !c.faceUp).length),
    stockN: G.piles.stock.cards.length,
  };
}
function requestWinProb(){
  if (!winWorker || !oddsOn()) return;
  const pub = winPub();
  if (pub.found.reduce((n,a)=>n+a.length,0) === 52) return;   // already won
  const key = JSON.stringify(pub);
  if (key === lastPub) return;                          // position unchanged
  lastPub = key;
  winWorker.postMessage({ id: ++winSeq, pub, N: 48 });
}
function scheduleWinProb(){
  if (!winWorker || !oddsOn()) return;
  clearTimeout(winTimer);
  winTimer = setTimeout(requestWinProb, 250);
}
function resetWin(){ G.winHistory = []; lastPub = ""; drawWinChart(); }

// Paint the win-probability strip (band + expected line + label) into a context
// sized W×H (CSS px). Shared by the toolbar strip and the victory-popup recap.
function paintWinStrip(ctx, W, H, raw, label){
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a3d22"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#ffffff22"; ctx.lineWidth = 1;
  for (const g of [0.25, 0.5, 0.75]){ const y = H - g*H; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const hist = raw.length === 1 ? [raw[0], raw[0]] : raw;
  const n = hist.length;
  if (n < 2) return;
  const X = i => (i / (n - 1)) * W, Y = p => H - p * H;
  ctx.beginPath();
  for (let i = 0; i < n; i++){ const x = X(i), y = Y(hist[i].high); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  for (let i = n - 1; i >= 0; i--){ ctx.lineTo(X(i), Y(hist[i].low)); }
  ctx.closePath(); ctx.fillStyle = "#ffd54a33"; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < n; i++){ const x = X(i), y = Y(hist[i].mid); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.strokeStyle = "#ffd54a"; ctx.lineWidth = 2.6; ctx.lineJoin = "round"; ctx.stroke();
  if (label){
    ctx.fillStyle = "#eafff1"; ctx.font = "600 12px -apple-system,Arial,sans-serif"; ctx.textAlign = "left";
    ctx.fillText(label, 8, 15);
  }
}

// Size a canvas to its CSS box at device-pixel resolution and return a ready ctx.
function fitCanvasCtx(cv, cssW, cssH){
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
  if (cv.width !== pw || cv.height !== ph){ cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function winLabel(raw){
  if (!raw.length) return "";
  const cur = raw[raw.length - 1];
  return `win ≈ ${Math.round(cur.mid*100)}%  ( ${Math.round(cur.low*100)}–${Math.round(cur.high*100)} )`;
}

function drawWinChart(){
  const cv = winCanvas; if (!cv) return;
  if (!oddsOn()){ cv.style.display = "none"; return; }
  cv.style.display = "block";
  const raw = G.winHistory || [];
  const cssW = cv.clientWidth || 320, cssH = 66;
  paintWinStrip(fitCanvasCtx(cv, cssW, cssH), cssW, cssH, raw, winLabel(raw));
}

// Recap chart shown inside the "You win!" popup, so the player can see how the
// odds swung on the game they just took. Hidden if no odds were tracked.
function drawFinalWinChart(){
  const wrap = document.getElementById("winOddsWrap");
  const cv = document.getElementById("winchartFinal");
  if (!wrap || !cv) return;
  const raw = G.winHistory || [];
  if (raw.length < 2){ wrap.hidden = true; return; }
  wrap.hidden = false;
  requestAnimationFrame(() => {                          // let the popup lay out first
    const cssW = cv.clientWidth || 440, cssH = 104;
    paintWinStrip(fitCanvasCtx(cv, cssW, cssH), cssW, cssH, raw, winLabel(raw));
  });
}

oddsToggle.checked = (lsGet("odds") ?? "1") === "1";          // default on, remembered
oddsToggle.addEventListener("change", () => {
  lsSet("odds", oddsToggle.checked ? "1" : "0");
  if (oddsToggle.checked){ lastPub = ""; requestWinProb(); }
  drawWinChart();
});
window.addEventListener("resize", drawWinChart);

// Resume an in-progress game if one was saved; otherwise deal a fresh one.
if (tryRestore()) maybeShowInstall(parseInt(lsGet("games") || "0", 10));
else startGame();

// Quick win-screen test: load with ?win (optionally + ?prize / ?prize=0).
if (PARAMS.has("win")) showWin();
