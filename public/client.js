/* global io */
// ─────────────────────────────────────────────────────────────
// Solither client — client-side prediction + entity interpolation
// + a cheap, smooth stroked renderer. Designed to feel lag-free.
// ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ── Sound (Web Audio, all synthesized — no asset files) ──────
const SFX = (() => {
  let ctx = null, master = null, muted = localStorage.getItem('solither_muted') === '1';
  let boostOsc = null, boostGain = null, lastEat = 0;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  function blip(freq, dur, type, vol, slideTo) {
    if (!ctx || muted) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + dur);
    o.connect(g); g.connect(master);
    o.start(); o.stop(ctx.currentTime + dur);
  }

  function stopBoost() {
    if (boostOsc) {
      try {
        boostGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
        boostOsc.stop(ctx.currentTime + 0.1);
      } catch (e) { /* already stopped */ }
      boostOsc = null; boostGain = null;
    }
  }

  return {
    init: ensure,
    isMuted: () => muted,
    setMuted(m) {
      muted = m;
      localStorage.setItem('solither_muted', m ? '1' : '0');
      if (master) master.gain.value = m ? 0 : 0.5;
      if (m) stopBoost();
    },
    eat() {
      const now = performance.now();
      if (now - lastEat < 55) return; // throttle rapid eats
      lastEat = now;
      blip(520 + Math.random() * 90, 0.08, 'triangle', 0.16, 900);
    },
    death() { ensure(); blip(340, 0.5, 'sawtooth', 0.3, 70); },
    tick() { ensure(); blip(1040, 0.06, 'square', 0.12); },
    roundWin() {
      ensure();
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.2, 'square', 0.2), i * 110));
    },
    startBoost() {
      if (!ctx || muted || boostOsc) return;
      boostOsc = ctx.createOscillator();
      boostGain = ctx.createGain();
      boostOsc.type = 'sawtooth';
      boostOsc.frequency.value = 95;
      boostGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      boostGain.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 0.1);
      boostOsc.connect(boostGain); boostGain.connect(master);
      boostOsc.start();
    },
    stopBoost,
  };
})();

const canvas = $('game');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');

let DPR = Math.min(window.devicePixelRatio || 1, 2);
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * DPR);
  canvas.height = Math.floor(window.innerHeight * DPR);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
window.addEventListener('resize', resize);
resize();

// ── Config / sim constants (filled from server) ──────────────
let serverConfig = { demoMode: true, minTokenBalance: 500000, roundSeconds: 300, rewardTopN: 3 };
let SIM = {
  tickRate: 30, baseSpeed: 3.9, boostSpeed: 7.4, turnRate: 0.24,
  pointSpacing: 4, startLength: 20, minBoostLength: 25, worldRadius: 2600,
};
let world = { radius: 2600 };

// ── Networking state ─────────────────────────────────────────
let socket = null;
let myId = null;
let playing = false;
let lastJoin = null;        // { name, wallet } — for auto re-join on reconnect
let hasJoinedOnce = false;
let reconnectResume = false; // were we in-world when the connection dropped?
let selectedSkin = localStorage.getItem('solither_skin') || null;

// Player settings (persisted). Sound is governed by SFX (solither_muted).
const settings = {
  minimap: localStorage.getItem('solither_minimap') !== '0',
  particles: localStorage.getItem('solither_particles') !== '0',
};

const NET_HZ = 22;
const INTERP_DELAY = 95; // ms behind realtime for smooth remote motion
const buffer = [];       // [{ t, byId:Map, food }]
let latestFood = [];
let leaderboardData = [];
let onlineCount = 0;

// ── Local prediction (your snake) ────────────────────────────
const pred = {
  active: false,
  x: 0, y: 0, a: 0,
  length: SIM.startLength,
  boosting: false,
  trail: [],          // dense points, head first
  color: '#14F195',
  name: 'You',
  serverX: 0, serverY: 0,
};

// ── Input ────────────────────────────────────────────────────
let mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let boosting = false;
let isBoosting = false; // boosting AND allowed (enough mass) — drives visuals
let wasBoosting = false; // previous frame's boost state, for sound transitions
const fx = [];          // boost particles { x, y, vx, vy, life, max, r, color }
const pops = [];        // floating "+N" eat popups { x, y, vy, text, life, max, color }
let headFlashUntil = 0; // ms timestamp until which the local head flashes white
let prevLen = null;     // last server length, to detect eating
let lastCoilWarn = 0;   // throttle the anti-coil warning toast
const confetti = [];    // screen-space celebration particles
let rwHideTimer = null;

const cam = { x: 0, y: 0, init: false };

// Spectate: when dead and watching, follow the live leader's head.
let spectating = false;
const specTarget = { x: 0, y: 0, has: false, id: null };

// ── Load public config ───────────────────────────────────────
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  serverConfig = cfg;
  if (cfg.sim) SIM = cfg.sim;
  world.radius = SIM.worldRadius;
  $('roundMins').textContent = Math.round(cfg.roundSeconds / 60);
  $('topNNote').textContent = cfg.rewardTopN;
  const tagN = $('taglineTopN'); if (tagN) tagN.textContent = cfg.rewardTopN;
  buildSkinPicker(cfg.skins || []);
  const gate = $('gateNote');
  if (cfg.demoMode) {
    gate.classList.add('demo');
    gate.innerHTML = '🟢 <b>Demo mode</b> — no token required. Paste any wallet to try it.';
  } else {
    gate.innerHTML =
      `🔒 Hold <b>${cfg.minTokenBalance.toLocaleString()}</b> tokens of ` +
      `<code>${shortMint(cfg.tokenMint)}</code> to play.`;
  }
}).catch(() => {});

fetch('/api/rounds').then((r) => r.json()).then(renderRecentRounds).catch(() => {});
fetchHighScores();
fetchRewards();

function shortMint(m) { return m ? m.slice(0, 4) + '…' + m.slice(-4) : ''; }

function fetchHighScores() {
  fetch('/api/highscores').then((r) => r.json()).then(renderHighScores).catch(() => {});
}

const fmtSol = (n) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });

function fetchRewards() {
  fetch('/api/rewards').then((r) => r.json()).then(renderRewards).catch(() => {});
}

function renderRewards(d) {
  if (!d) return;
  $('rbTotal').textContent = fmtSol(d.totalSol);
  const pool = d.roundPoolSol || 0;
  $('rbSub').textContent = `${fmtSol(pool)} SOL/round · split among top ${serverConfig.rewardTopN} · ${d.rounds || 0} rounds paid`;
  $('rewardsBanner').classList.remove('hidden');

  if (d.top && d.top.length) {
    const ol = $('topEarnersList');
    ol.innerHTML = '';
    d.top.forEach((e, i) => {
      const li = document.createElement('li');
      const label = e.name || shortMint(e.wallet);
      li.innerHTML = `<span class="w-name">#${i + 1} ${escapeHtml(label)}</span><span>${fmtSol(e.sol)} SOL</span>`;
      ol.appendChild(li);
    });
    $('topEarnersBox').classList.remove('hidden');
  }
}

function renderHighScores(list) {
  if (!list || !list.length) return;
  const ol = $('highScoresList');
  ol.innerHTML = '';
  list.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="w-name">#${i + 1} ${escapeHtml(s.name)}</span><span>${s.score}</span>`;
    ol.appendChild(li);
  });
  $('highScoresBox').classList.remove('hidden');
}

function buildSkinPicker(skins) {
  const wrap = $('skinPicker');
  if (!wrap || !skins.length) return;
  if (!skins.includes(selectedSkin)) selectedSkin = skins[0];
  wrap.innerHTML = '';
  for (const c of skins) {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c === selectedSkin ? ' sel' : '');
    sw.style.background = c;
    sw.style.color = c; // for the glow (currentColor)
    sw.title = c;
    sw.addEventListener('click', () => {
      selectedSkin = c;
      localStorage.setItem('solither_skin', c);
      wrap.querySelectorAll('.swatch').forEach((s) => s.classList.remove('sel'));
      sw.classList.add('sel');
    });
    wrap.appendChild(sw);
  }
}

function renderRecentRounds(history) {
  if (!history || !history.length) return;
  // history is most-recent-first; show the last 5 rounds that had winners.
  const withWinners = history.filter((h) => h.winners && h.winners.length).slice(0, 5);
  if (!withWinners.length) return;
  const box = $('recentRounds');
  box.innerHTML = '';
  for (const rec of withWinners) {
    const block = document.createElement('div');
    block.className = 'round-block';
    const head = document.createElement('div');
    head.className = 'round-head';
    head.textContent = `Round ${rec.round}`;
    block.appendChild(head);
    const ol = document.createElement('ol');
    rec.winners.forEach((w) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="w-name">#${w.rank} ${escapeHtml(w.name)}</span><span>${w.score}</span>`;
      ol.appendChild(li);
    });
    block.appendChild(ol);
    box.appendChild(block);
  }
  $('winnersBox').classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Join flow ────────────────────────────────────────────────
$('playBtn').addEventListener('click', join);
$('walletInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
$('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('walletInput').focus(); });

let pendingName = 'Anon';

async function join() {
  const name = $('nameInput').value.trim() || 'Anon';
  const wallet = $('walletInput').value.trim();
  const btn = $('playBtn');
  const err = $('joinError');
  err.textContent = '';
  pendingName = name;

  if (!wallet) { err.textContent = 'Paste a Solana wallet address.'; return; }

  btn.disabled = true;
  btn.textContent = 'CHECKING…';

  try {
    const res = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet }),
    }).then((r) => r.json());
    if (!res.ok) { err.textContent = res.reason || 'Wallet not eligible.'; resetBtn(); return; }
  } catch {
    err.textContent = 'Server unreachable. Is it running?'; resetBtn(); return;
  }

  connectAndJoin(name, wallet);
}

function resetBtn() { const b = $('playBtn'); b.disabled = false; b.textContent = 'PLAY'; }

function connectAndJoin(name, wallet) {
  lastJoin = { name, wallet, color: selectedSkin };
  if (!socket) { socket = io(); wireSocket(); }
  socket.emit('join', lastJoin, (resp) => {
    if (!resp || !resp.ok) { $('joinError').textContent = (resp && resp.reason) || 'Could not join.'; resetBtn(); return; }
    myId = resp.playerId;
    world = resp.world || world;
    pred.name = name;
    if (selectedSkin) pred.color = selectedSkin;
    pred.active = false;
    prevLen = null;
    buffer.length = 0;
    hasJoinedOnce = true;
    startPlaying();
  });
}

function setConn(ok) {
  const d = $('connDot');
  if (d) d.classList.toggle('off', !ok);
}

function populatePlayerBadge() {
  const badge = $('playerBadge');
  if (!badge || !lastJoin) return;
  const c = selectedSkin || pred.color;
  const dot = $('pbDot');
  if (dot) { dot.style.background = c; dot.style.color = c; }
  $('pbName').textContent = lastJoin.name || 'You';
  $('pbWallet').textContent = lastJoin.wallet ? shortMint(lastJoin.wallet) : '';
  badge.classList.remove('hidden');
}

function startPlaying() {
  playing = true;
  SFX.init(); // first play is a user gesture — safe to start audio
  spectating = false; specTarget.has = false;
  $('lobby').classList.add('hidden');
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.add('hidden');
  $('hud').classList.remove('hidden');
  populatePlayerBadge();
  resetBtn();
}

// ── Socket events ────────────────────────────────────────────
function wireSocket() {
  socket.on('state', (s) => {
    // HUD
    if (s.round) updateRoundUI(s.round);
    leaderboardData = s.leaderboard || [];
    onlineCount = s.players || 0;
    updateLeaderboard(leaderboardData);
    renderMyRankRow(leaderboardData, s.me);
    $('playersVal').textContent = onlineCount;

    // Buffer remote snakes for interpolation (exclude my own — predicted).
    const byId = new Map();
    if (s.snakes) for (const sn of s.snakes) if (sn.id !== myId) byId.set(sn.id, sn);
    buffer.push({ t: performance.now(), byId, food: s.food || [] });
    while (buffer.length > 14) buffer.shift();
    latestFood = s.food || latestFood;

    // Spectate target (sent only while we're spectating the leader).
    if (spectating && s.spectate) {
      specTarget.x = s.spectate.x; specTarget.y = s.spectate.y; specTarget.has = true;
      specTarget.id = s.spectate.id;
      const nm = $('specName');
      if (nm) nm.textContent = s.spectate.name;
    }

    // Reconcile / seed local prediction.
    if (s.me && s.me.alive) {
      $('scoreVal').textContent = s.me.length || 0;
      { const pl = $('pbLen'); if (pl) pl.textContent = s.me.length || 0; }
      // Detect eating (length up) for the "+N" pop + head flash.
      if (prevLen !== null && s.me.length > prevLen && pred.active) {
        const gain = s.me.length - prevLen;
        if (settings.particles) {
          pops.push({ x: pred.x, y: pred.y - bodyRadius(pred.length) - 8, vy: -0.45, text: '+' + gain, life: 0, max: 750, color: pred.color });
        }
        headFlashUntil = performance.now() + 150;
        SFX.eat();
      }
      prevLen = s.me.length;
      pred.length = s.me.length || pred.length;
      pred.serverX = s.me.x; pred.serverY = s.me.y;
      // Anti-coil warning toast (throttled) while the server is draining for camping.
      if (s.me.coiling) {
        const now = performance.now();
        if (now - lastCoilWarn > 2500) { showToast('🌀 Stop coiling — move or you lose mass!'); lastCoilWarn = now; }
      }
      // Find my color from the snapshot.
      if (s.snakes) {
        const mine = s.snakes.find((sn) => sn.id === myId);
        if (mine) pred.color = mine.color;
      }
      if (!pred.active) {
        pred.active = true;
        pred.x = s.me.x; pred.y = s.me.y; pred.a = typeof s.me.a === 'number' ? s.me.a : 0;
        seedTrail();
        if (!cam.init) { cam.x = pred.x; cam.y = pred.y; cam.init = true; }
      }
    }
  });

  socket.on('dead', (info) => {
    playing = false;
    pred.active = false;
    prevLen = null;
    SFX.stopBoost();
    SFX.death();
    $('deathReason').textContent =
      info.cause === 'wall' ? 'You hit the edge of the world.'
        : info.killedBy ? `Cut off by ${info.killedBy}.`
          : 'You ran into another snake.';
    $('dsPeak').textContent = info.peakLength != null ? info.peakLength : (info.score || 0);
    $('dsKills').textContent = info.kills != null ? info.kills : 0;
    $('dsRank').textContent = info.rank != null ? `#${info.rank}${info.totalPlayers ? '/' + info.totalPlayers : ''}` : '—';
    const secs = Math.floor((info.survivalMs || 0) / 1000);
    $('dsTime').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    $('deathScreen').classList.remove('hidden');
  });

  socket.on('roundEnded', (record) => {
    SFX.roundWin();
    if (record.winners && record.winners.length) {
      showRoundWin(record);
    } else {
      showToast(`Round ${record.round} ended.`);
    }
  });
  socket.on('kill', (k) => addKillFeed(k));
  socket.on('roundStarted', (st) => updateRoundUI(st));

  // ── Connection status + auto-reconnect ──
  socket.on('connect', () => {
    setConn(true);
    if (hasJoinedOnce && reconnectResume) {
      socket.emit('join', lastJoin, (resp) => {
        if (resp && resp.ok) {
          myId = resp.playerId;
          pred.active = false; prevLen = null; buffer.length = 0;
          spectating = false; specTarget.has = false;
          $('deathScreen').classList.add('hidden');
          $('spectateBar').classList.add('hidden');
          playing = true;
          showToast('Reconnected — back in!');
        }
        reconnectResume = false;
      });
    }
  });

  socket.on('disconnect', () => {
    setConn(false);
    SFX.stopBoost();
    if (playing || spectating) { reconnectResume = true; showToast('Connection lost — reconnecting…'); }
    playing = false;
  });

  // Manager-level reconnect attempts keep the dot red until we're back.
  if (socket.io) socket.io.on('reconnect_attempt', () => setConn(false));
}

function addKillFeed(k) {
  const feed = $('killFeed');
  if (!feed) return;
  const item = document.createElement('div');
  item.className = 'kill-item';
  let html;
  if (k.killerId === myId) {
    item.classList.add('you-killed');
    html = `<span class="k">You</span> ate <span class="v">${escapeHtml(k.victim)}</span> 🍴`;
  } else if (k.victimId === myId) {
    item.classList.add('you-died');
    html = `<span class="k">${escapeHtml(k.killer)}</span> ate <span class="v">you</span> 💀`;
  } else {
    html = `<span class="k">${escapeHtml(k.killer)}</span> ate <span class="v">${escapeHtml(k.victim)}</span>`;
  }
  item.innerHTML = html;
  feed.prepend(item);
  while (feed.children.length > 5) feed.removeChild(feed.lastChild);
  setTimeout(() => item.classList.add('fading'), 3500);
  setTimeout(() => item.remove(), 4000);
}

function seedTrail() {
  pred.trail = [];
  const n = Math.max(SIM.startLength, Math.floor(pred.length));
  for (let i = 0; i < n; i++) {
    pred.trail.push({ x: pred.x - Math.cos(pred.a) * i * SIM.pointSpacing, y: pred.y - Math.sin(pred.a) * i * SIM.pointSpacing });
  }
}

function doRespawn() {
  socket.emit('respawn', {}, (resp) => {
    if (resp && resp.ok) {
      myId = resp.playerId;
      pred.active = false; prevLen = null; buffer.length = 0;
      spectating = false; specTarget.has = false;
      $('spectateBar').classList.add('hidden');
      startPlaying();
    }
  });
}

$('respawnBtn').addEventListener('click', doRespawn);
$('specRespawnBtn').addEventListener('click', doRespawn);

$('spectateBtn').addEventListener('click', () => {
  spectating = true; specTarget.has = false; specTarget.id = null;
  socket.emit('spectate');
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.remove('hidden');
});

function cycleSpectate(dir) {
  if (!spectating || !socket) return;
  const lb = leaderboardData || [];
  if (!lb.length) return;
  let idx = lb.findIndex((p) => p.id === specTarget.id);
  idx = idx < 0 ? 0 : (idx + dir + lb.length) % lb.length;
  socket.emit('spectate', { targetId: lb[idx].id });
}
$('specNextBtn').addEventListener('click', () => cycleSpectate(1));

$('quitBtn').addEventListener('click', () => {
  playing = false; pred.active = false;
  spectating = false; specTarget.has = false;
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.add('hidden');
  $('playerBadge').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  fetch('/api/rounds').then((r) => r.json()).then(renderRecentRounds).catch(() => {});
  fetchHighScores();
  fetchRewards();
});

// ── Round / leaderboard UI ───────────────────────────────────
let lastTickSec = -1;
function updateRoundUI(round) {
  if (!round) return;
  const sec = Math.ceil(round.msRemaining / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  $('roundTimer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('roundPill').classList.toggle('urgent', sec <= 15);

  // Urgency cue (in-game only): edge pulse in the last 10s, tick the last 5s.
  const inGame = !$('hud').classList.contains('hidden');
  const vig = $('urgentVignette');
  if (vig) vig.classList.toggle('hidden', !(inGame && sec <= 10 && sec > 0));
  if (inGame && sec <= 5 && sec >= 1 && sec !== lastTickSec) SFX.tick();
  lastTickSec = sec;
}

// Show fewer rows on phones so the board doesn't cover the top-right of the screen.
function leaderboardLimit() { return window.innerWidth <= 560 ? 6 : 10; }

function updateLeaderboard(lb) {
  const list = $('lbList');
  list.innerHTML = '';
  lb.slice(0, leaderboardLimit()).forEach((p, i) => {
    const li = document.createElement('li');
    if (p.id === myId) li.classList.add('me');
    if (i < serverConfig.rewardTopN) li.classList.add('top3');
    li.innerHTML =
      `<span class="rank">${i + 1}</span>` +
      `<span class="nm">${escapeHtml(p.name)}${p.isBot ? ' 🤖' : ''}</span>` +
      `<span class="sc">${p.score}</span>`;
    list.appendChild(li);
  });
}

const MEDALS = ['🥇', '🥈', '🥉'];
function showRoundWin(record) {
  $('rwNum').textContent = record.round;
  $('rwTopN').textContent = serverConfig.rewardTopN;
  const podium = $('rwPodium');
  podium.innerHTML = '';
  record.winners.forEach((w, i) => {
    const li = document.createElement('li');
    if (i === 0) li.classList.add('rank1');
    li.innerHTML =
      `<span class="medal">${MEDALS[i] || '🏅'}</span>` +
      `<span class="rw-name">${escapeHtml(w.name)}</span>` +
      `<span class="rw-score">${w.score}</span>`;
    podium.appendChild(li);
  });
  $('roundWinOverlay').classList.remove('hidden');
  spawnConfetti(150);
  clearTimeout(rwHideTimer);
  rwHideTimer = setTimeout(() => $('roundWinOverlay').classList.add('hidden'), 5500);
}

const CONFETTI_COLORS = ['#14F195', '#9945FF', '#fff', '#F72585', '#FFD166', '#4CC9F0'];
function spawnConfetti(n) {
  if (!settings.particles) return;
  const W = window.innerWidth;
  for (let i = 0; i < n; i++) {
    confetti.push({
      x: W / 2 + (Math.random() - 0.5) * W * 0.7,
      y: -20 - Math.random() * 80,
      vx: (Math.random() - 0.5) * 6,
      vy: 2 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      size: 5 + Math.random() * 6,
      color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
      life: 0, max: 2600 + Math.random() * 1200,
    });
  }
}
function updateConfetti(dtMs) {
  const k = dtMs / 16;
  const H = window.innerHeight;
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.life += dtMs;
    c.x += c.vx * k; c.y += c.vy * k; c.vy += 0.12 * k; c.rot += c.vr * k;
    if (c.life >= c.max || c.y > H + 30) confetti.splice(i, 1);
  }
}
function drawConfetti() {
  for (const c of confetti) {
    const t = 1 - c.life / c.max;
    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 2);
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * 0.6);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function renderMyRankRow(lb, me) {
  const row = $('myRankRow');
  if (!row) return;
  const inTop = lb.slice(0, leaderboardLimit()).some((p) => p.id === myId);
  if (!playing || !me || !me.alive || inTop || !me.rank) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  const name = (lastJoin && lastJoin.name) || pred.name || 'You';
  row.innerHTML =
    `<span class="arrow">▾</span>` +
    `<span class="rank">${me.rank}</span>` +
    `<span class="nm">${escapeHtml(name)}</span>` +
    `<span class="sc">${me.score || 0}</span>`;
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── Input listeners ──────────────────────────────────────────
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', () => { boosting = true; });
window.addEventListener('mouseup', () => { boosting = false; });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') boosting = true;
  if (spectating) {
    if (e.code === 'ArrowRight') cycleSpectate(1);
    else if (e.code === 'ArrowLeft') cycleSpectate(-1);
  }
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') boosting = false; });
window.addEventListener('contextmenu', (e) => e.preventDefault());
// Touch: drag ANYWHERE to steer (no boost). Boost is the dedicated button ONLY,
// so steering no longer wastes mass/score on boost (mobile fix). The steering finger
// is tracked by identifier and ignores touches that begin on the boost button.
let steerTouchId = null;
const isBoostTouch = (t) => t.target && t.target.closest && t.target.closest('#boostBtn');
window.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) {
    if (isBoostTouch(t)) continue;
    if (steerTouchId === null) { steerTouchId = t.identifier; mouse.x = t.clientX; mouse.y = t.clientY; }
  }
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === steerTouchId) { mouse.x = t.clientX; mouse.y = t.clientY; }
  }
}, { passive: true });
function endSteerTouch(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === steerTouchId) steerTouchId = null;
  }
}
window.addEventListener('touchend', endSteerTouch, { passive: true });
window.addEventListener('touchcancel', endSteerTouch, { passive: true });

// Mobile / click boost button.
const boostBtn = $('boostBtn');
if (boostBtn) {
  const on = (e) => { e.preventDefault(); boosting = true; };
  const off = (e) => { e.preventDefault(); boosting = false; };
  boostBtn.addEventListener('touchstart', on, { passive: false });
  boostBtn.addEventListener('touchend', off, { passive: false });
  boostBtn.addEventListener('mousedown', on);
  boostBtn.addEventListener('mouseup', off);
  boostBtn.addEventListener('mouseleave', off);
}

function desiredAngle() {
  return Math.atan2(mouse.y - window.innerHeight / 2, mouse.x - window.innerWidth / 2);
}

// Mute toggle (reflects + persists via SFX/localStorage).
const muteBtn = $('muteBtn');
function renderMute() {
  const m = SFX.isMuted();
  muteBtn.textContent = m ? '🔇' : '🔊';
  muteBtn.classList.toggle('muted', m);
}
if (muteBtn) {
  renderMute();
  muteBtn.addEventListener('click', () => {
    SFX.init();
    SFX.setMuted(!SFX.isMuted());
    renderMute();
  });
}

// Settings panel (sound / minimap / particles), persisted to localStorage.
function applyMinimapVisibility() {
  const w = $('minimapWrap');
  if (w) w.style.display = settings.minimap ? '' : 'none';
}
applyMinimapVisibility();

const settingsBtn = $('settingsBtn');
const settingsPanel = $('settingsPanel');
if (settingsBtn && settingsPanel) {
  const syncSettingsUI = () => {
    $('setSound').checked = !SFX.isMuted();
    $('setMinimap').checked = settings.minimap;
    $('setParticles').checked = settings.particles;
  };
  settingsBtn.addEventListener('click', () => {
    const nowHidden = settingsPanel.classList.toggle('hidden');
    if (!nowHidden) syncSettingsUI();
  });
  $('setSound').addEventListener('change', (e) => { SFX.init(); SFX.setMuted(!e.target.checked); renderMute(); });
  $('setMinimap').addEventListener('change', (e) => {
    settings.minimap = e.target.checked;
    localStorage.setItem('solither_minimap', e.target.checked ? '1' : '0');
    applyMinimapVisibility();
  });
  $('setParticles').addEventListener('change', (e) => {
    settings.particles = e.target.checked;
    localStorage.setItem('solither_particles', e.target.checked ? '1' : '0');
  });
}

// Send input to server ~22x/s.
setInterval(() => {
  if (!playing || !socket) return;
  socket.emit('input', { targetAngle: desiredAngle(), boosting });
}, 1000 / 22);

// ── Local prediction integration ─────────────────────────────
function angLerp(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function predict(dtMs) {
  if (!pred.active) return;
  const dt = Math.min(dtMs, 60) / (1000 / SIM.tickRate); // in "ticks"

  // steer toward mouse
  const target = desiredAngle();
  let diff = target - pred.a;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = SIM.turnRate * dt;
  pred.a += Math.max(-maxTurn, Math.min(maxTurn, diff));

  const canBoost = pred.length > SIM.minBoostLength;
  isBoosting = boosting && canBoost;

  let speed = SIM.baseSpeed;
  if (isBoosting) {
    speed = SIM.boostSpeed;
    // Emit flame particles out the back of the head.
    if (settings.particles && pred.trail.length > 1) {
      const back = pred.a + Math.PI;
      for (let i = 0; i < 2; i++) {
        const spread = (Math.random() - 0.5) * 0.7;
        const sp = 0.6 + Math.random() * 1.2;
        fx.push({
          x: pred.x - Math.cos(pred.a) * 6,
          y: pred.y - Math.sin(pred.a) * 6,
          vx: Math.cos(back + spread) * sp,
          vy: Math.sin(back + spread) * sp,
          life: 0, max: 260 + Math.random() * 160,
          r: 2 + Math.random() * 3, color: pred.color,
        });
      }
    }
  }

  pred.x += Math.cos(pred.a) * speed * dt;
  pred.y += Math.sin(pred.a) * speed * dt;

  // Keep inside world (visual only; server is authoritative for death).
  const d = Math.hypot(pred.x, pred.y);
  if (d > world.radius) { const k = world.radius / d; pred.x *= k; pred.y *= k; }

  // Gentle reconciliation toward the server position to bound drift.
  const ex = pred.serverX - pred.x, ey = pred.serverY - pred.y;
  const err = Math.hypot(ex, ey);
  if (err > 220) { pred.x = pred.serverX; pred.y = pred.serverY; } // hard correct on big desync
  else { pred.x += ex * 0.08; pred.y += ey * 0.08; }

  // Record dense trail.
  const head = pred.trail[0];
  if (!head || Math.hypot(pred.x - head.x, pred.y - head.y) >= SIM.pointSpacing) {
    pred.trail.unshift({ x: pred.x, y: pred.y });
  }
  const maxPoints = Math.max(SIM.startLength, Math.floor(pred.length));
  while (pred.trail.length > maxPoints) pred.trail.pop();
}

function bodyRadius(length) { return 11 + Math.min(18, length / 60); }

function updateFx(dtMs) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const p = fx[i];
    p.life += dtMs;
    if (p.life >= p.max) { fx.splice(i, 1); continue; }
    p.x += p.vx * (dtMs / 16);
    p.y += p.vy * (dtMs / 16);
    p.vx *= 0.94; p.vy *= 0.94;
  }
  if (fx.length > 400) fx.splice(0, fx.length - 400);

  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.life += dtMs;
    if (p.life >= p.max) { pops.splice(i, 1); continue; }
    p.y += p.vy * (dtMs / 16);
  }
}

function drawPops() {
  ctx.textAlign = 'center';
  ctx.font = '700 16px Space Grotesk, sans-serif';
  for (const p of pops) {
    const t = 1 - p.life / p.max;
    ctx.globalAlpha = Math.min(1, t * 1.6);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = p.color; ctx.shadowBlur = 8;
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function drawFx() {
  for (const p of fx) {
    const t = 1 - p.life / p.max;
    ctx.globalAlpha = t * 0.8;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * t, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function updateBoostHud() {
  const btn = $('boostBtn');
  if (!btn) return;
  const canBoost = pred.active && pred.length > SIM.minBoostLength;
  btn.classList.toggle('active', isBoosting);
  btn.classList.toggle('disabled', !canBoost);
}

// ── Interpolated remote snakes ───────────────────────────────
function interpolatedSnakes() {
  const renderTime = performance.now() - INTERP_DELAY;
  if (buffer.length === 0) return [];

  let older = null, newer = null;
  for (let i = buffer.length - 1; i > 0; i--) {
    if (buffer[i - 1].t <= renderTime && buffer[i].t >= renderTime) { older = buffer[i - 1]; newer = buffer[i]; break; }
  }
  if (!newer) { newer = buffer[buffer.length - 1]; older = newer; }
  const span = (newer.t - older.t) || 1;
  const f = Math.max(0, Math.min(1, (renderTime - older.t) / span));

  const out = [];
  for (const [id, b] of newer.byId) {
    const a = older.byId.get(id);
    if (!a) { out.push(b); continue; }
    const segs = [];
    const n = Math.min(a.segs.length, b.segs.length);
    for (let i = 0; i < n; i++) {
      segs.push([a.segs[i][0] + (b.segs[i][0] - a.segs[i][0]) * f,
                 a.segs[i][1] + (b.segs[i][1] - a.segs[i][1]) * f]);
    }
    for (let i = n; i < b.segs.length; i++) segs.push(b.segs[i]);
    out.push({
      id, name: b.name, color: b.color, r: b.r, score: b.score, boosting: b.boosting,
      x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
      a: angLerp(a.a, b.a, f), segs,
    });
  }
  return out;
}

// ── Rendering ────────────────────────────────────────────────
let lastFrame = performance.now();

// Pause cleanly when the tab is backgrounded (the browser already pauses rAF,
// which saves CPU). On return, avoid a huge dt jump / stale interpolation / stuck boost.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    boosting = false;
    SFX.stopBoost();
  } else {
    lastFrame = performance.now(); // don't integrate a multi-second dt on resume
    buffer.length = 0;             // drop stale snapshots so interpolation restarts fresh
  }
});

function render(now) {
  requestAnimationFrame(render);
  const dt = now - lastFrame;
  lastFrame = now;

  predict(dt);
  updateFx(dt);
  updateConfetti(dt);

  // Boost hum: start/stop on transition.
  if (isBoosting && !wasBoosting) SFX.startBoost();
  else if (!isBoosting && wasBoosting) SFX.stopBoost();
  wasBoosting = isBoosting;

  // Camera follows the predicted head, or the spectated leader when dead.
  if (spectating && specTarget.has) {
    cam.x += (specTarget.x - cam.x) * Math.min(1, dt / 120);
    cam.y += (specTarget.y - cam.y) * Math.min(1, dt / 120);
  } else if (pred.active) {
    if (!cam.init) { cam.x = pred.x; cam.y = pred.y; cam.init = true; }
    cam.x += (pred.x - cam.x) * Math.min(1, dt / 90);
    cam.y += (pred.y - cam.y) * Math.min(1, dt / 90);
  }

  const W = window.innerWidth, H = window.innerHeight;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#07060d';
  ctx.fillRect(0, 0, W, H);
  drawNebula(W, H);
  drawStars(W, H);

  ctx.save();
  ctx.translate(W / 2 - cam.x, H / 2 - cam.y);

  drawGrid(W, H);
  drawWorldEdge();
  drawFood();
  drawFx();

  const remotes = interpolatedSnakes();
  for (const sn of remotes) drawSnake(sn.segs, sn.x, sn.y, sn.a, sn.r, sn.color, sn.name, sn.boosting);
  if (pred.active) {
    drawSnake(pred.trail.map((p) => [p.x, p.y]), pred.x, pred.y, pred.a, bodyRadius(pred.length), pred.color, pred.name, isBoosting);
    // Head flash on eat.
    if (performance.now() < headFlashUntil) {
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(pred.x, pred.y, bodyRadius(pred.length) * 1.15, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  drawPops();

  ctx.restore();

  drawConfetti(); // screen-space, above the world
  if (settings.minimap) drawMinimap(remotes);
  updateBoostHud();

  // Pulse the urgency vignette from here (avoids an infinite CSS animation).
  const vig = $('urgentVignette');
  if (vig && !vig.classList.contains('hidden')) {
    vig.style.opacity = (0.4 + 0.45 * (0.5 + 0.5 * Math.sin(now / 320))).toFixed(3);
  }
}

// ── Parallax starfield + nebula background ───────────────────
const STAR_TILE = 1000;
function makeStars(n, sizeMax, aBase) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      x: Math.random() * STAR_TILE,
      y: Math.random() * STAR_TILE,
      size: 0.6 + Math.random() * sizeMax,
      a: aBase * (0.4 + Math.random() * 0.6),
      phase: Math.random() * Math.PI * 2,
      tint: Math.random() < 0.22 ? (Math.random() < 0.5 ? '#9945FF' : '#14F195') : '#ffffff',
    });
  }
  return arr;
}
const starLayers = [
  { parallax: 0.15, stars: makeStars(50, 1.4, 0.55) }, // far, dim, slow
  { parallax: 0.35, stars: makeStars(35, 2.2, 0.9) },  // near, brighter, faster
];
const nebula = [
  { x: -600, y: -400, r: 900, color: 'rgba(153,69,255,0.10)' },
  { x: 700, y: 520, r: 1000, color: 'rgba(20,241,149,0.07)' },
  { x: 250, y: -900, r: 820, color: 'rgba(72,201,240,0.06)' },
];

function drawNebula(W, H) {
  const p = 0.2;
  for (const n of nebula) {
    const sx = W / 2 + (n.x - cam.x * p);
    const sy = H / 2 + (n.y - cam.y * p);
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, n.r);
    g.addColorStop(0, n.color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

function drawStars(W, H) {
  const now = performance.now();
  for (const layer of starLayers) {
    const p = layer.parallax;
    const ox = ((cam.x * p) % STAR_TILE + STAR_TILE) % STAR_TILE;
    const oy = ((cam.y * p) % STAR_TILE + STAR_TILE) % STAR_TILE;
    for (const s of layer.stars) {
      let bx = s.x - ox; if (bx < 0) bx += STAR_TILE;
      let by = s.y - oy; if (by < 0) by += STAR_TILE;
      const tw = 0.5 + 0.5 * Math.sin(now * 0.002 + s.phase);
      ctx.globalAlpha = s.a * (0.5 + 0.5 * tw);
      ctx.fillStyle = s.tint;
      for (let tx = bx - STAR_TILE; tx < W; tx += STAR_TILE) {
        for (let ty = by - STAR_TILE; ty < H; ty += STAR_TILE) {
          ctx.beginPath();
          ctx.arc(tx, ty, s.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

function drawGrid(W, H) {
  const step = 80;
  const startX = Math.floor((cam.x - W / 2) / step) * step;
  const startY = Math.floor((cam.y - H / 2) / step) * step;
  ctx.strokeStyle = 'rgba(153,69,255,0.06)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x < cam.x + W / 2 + step; x += step) { ctx.moveTo(x, cam.y - H / 2); ctx.lineTo(x, cam.y + H / 2); }
  for (let y = startY; y < cam.y + H / 2 + step; y += step) { ctx.moveTo(cam.x - W / 2, y); ctx.lineTo(cam.x + W / 2, y); }
  ctx.stroke();
}

function drawWorldEdge() {
  ctx.beginPath();
  ctx.arc(0, 0, world.radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,77,109,0.5)';
  ctx.lineWidth = 6; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,77,109,0.10)';
  ctx.lineWidth = 40; ctx.stroke();
}

function drawFood() {
  // Cheap: two flat arcs per pellet, no per-pellet shadow.
  for (const f of latestFood) {
    const x = f[0], y = f[1], r = f[2], color = f[3];
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, r * 2.1, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

// One stroked tube + one inner highlight + head + eyes + name.
function drawSnake(points, hx, hy, a, r, color, name, isBoost) {
  if (!points || points.length < 2) {
    // Just a head dot.
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Outer glow body (single pass).
    ctx.shadowColor = color;
    ctx.shadowBlur = isBoost ? 26 : 14;
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 2;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Inner highlight core.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = r * 0.9;
    ctx.stroke();
  }

  // Boost aura — pulsing ring around the head.
  if (isBoost) {
    const pulse = 1.3 + Math.sin(performance.now() / 70) * 0.18;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(hx, hy, r * pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Head
  ctx.shadowColor = color;
  ctx.shadowBlur = isBoost ? 24 : 16;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(hx, hy, r * 1.06, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  drawEyes(hx, hy, a, r);

  // Name
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '600 13px Space Grotesk, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, hx, hy - r - 8);
}

function drawEyes(hx, hy, a, r) {
  const off = r * 0.5, perp = a + Math.PI / 2;
  for (const sgn of [-1, 1]) {
    const ex = hx + Math.cos(a) * off * 0.4 + Math.cos(perp) * off * sgn;
    const ey = hy + Math.sin(a) * off * 0.4 + Math.sin(perp) * off * sgn;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex, ey, r * 0.28, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#06110b';
    ctx.beginPath(); ctx.arc(ex + Math.cos(a) * r * 0.12, ey + Math.sin(a) * r * 0.12, r * 0.14, 0, Math.PI * 2); ctx.fill();
  }
}

function drawMinimap(remotes) {
  const size = 160, R = world.radius;
  mctx.clearRect(0, 0, size, size);
  mctx.fillStyle = 'rgba(0,0,0,0.4)';
  mctx.beginPath(); mctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); mctx.fill();
  mctx.strokeStyle = 'rgba(255,77,109,0.4)';
  mctx.beginPath(); mctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2); mctx.stroke();

  const scale = (size / 2 - 4) / R;
  const toMap = (x, y) => [size / 2 + x * scale, size / 2 + y * scale];

  for (const sn of remotes) {
    const [mx, my] = toMap(sn.x, sn.y);
    mctx.fillStyle = sn.color;
    mctx.beginPath(); mctx.arc(mx, my, 2, 0, Math.PI * 2); mctx.fill();
  }
  if (pred.active) {
    const [mx, my] = toMap(pred.x, pred.y);
    mctx.fillStyle = '#fff';
    mctx.beginPath(); mctx.arc(mx, my, 3.5, 0, Math.PI * 2); mctx.fill();
  }
}

requestAnimationFrame(render);
