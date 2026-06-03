/* global io */
// ─────────────────────────────────────────────────────────────
// Solither client — client-side prediction + entity interpolation
// + a cheap, smooth stroked renderer. Designed to feel lag-free.
// ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

// ── Sound (Web Audio, all synthesized — no asset files) ──────
const SFX = (() => {
  let ctx = null, master = null, muted = localStorage.getItem('solither_muted') === '1';
  let boostNodes = [], boostGain = null, lastEat = 0;

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
    if (boostNodes.length) {
      try {
        boostGain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.14);
        for (const n of boostNodes) n.stop(ctx.currentTime + 0.16);
      } catch (e) { /* already stopped */ }
      boostNodes = []; boostGain = null;
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
    streak(n) { ensure(); const base = 440 + Math.min(n, 6) * 110; blip(base, 0.12, 'square', 0.22, base * 1.5); },
    roundWin() {
      ensure();
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => blip(f, 0.2, 'square', 0.2), i * 110));
    },
    deathMatch() {
      ensure();
      // Ominous battle-royale klaxon: a low boom, alternating alarm horns, then a rising sweep.
      blip(110, 0.6, 'sawtooth', 0.34, 80);
      [0, 1, 2, 3].forEach((i) => setTimeout(() => blip(i % 2 ? 196 : 262, 0.2, 'square', 0.24), 260 + i * 200));
      setTimeout(() => blip(330, 0.9, 'sawtooth', 0.3, 880), 1120);
    },
    startBoost() {
      // Boost is silent for now (the buzz and the turbo both sounded bad). No-op.
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
// A skin is { color, emoji|null }. (Legacy stored a plain colour string.)
let selectedSkin = (() => {
  try {
    const raw = localStorage.getItem('solither_skin');
    if (!raw) return null;
    if (raw[0] === '{') return JSON.parse(raw);
    return { color: raw, emoji: null };
  } catch { return null; }
})();
function saveSkin(s) { try { localStorage.setItem('solither_skin', JSON.stringify(s)); } catch {} }
const skinImages = {}; // skin key (e.g. 'duve') -> preloaded Image, for image-based skins

// Player settings (persisted). Sound is governed by SFX (solither_muted).
const settings = {
  minimap: localStorage.getItem('solither_minimap') !== '0',
  particles: localStorage.getItem('solither_particles') !== '0',
};

const NET_HZ = 22;
const INTERP_DELAY = 95; // ms behind realtime for smooth remote motion
const buffer = [];       // [{ t, byId:Map, food }]
let latestFood = [];
let latestBlips = [];    // [[x,y],…] every alive snake in the world — for a full minimap
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
  immune: false,      // brief spawn/reset immunity (mirrors server me.immune)
  skin: null,         // character head emoji (if a character skin is selected)
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
let freeWatching = false; // watching without being a player (no tokens needed)
let dmActive = false;     // a Death Match is currently running
const specTarget = { x: 0, y: 0, has: false, id: null };

// ── Load public config ───────────────────────────────────────
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  serverConfig = cfg;
  if (cfg.sim) SIM = cfg.sim;
  world.radius = SIM.worldRadius;
  $('roundMins').textContent = Math.round(cfg.roundSeconds / 60);
  $('topNNote').textContent = cfg.rewardTopN;
  const tagN = $('taglineTopN'); if (tagN) tagN.textContent = cfg.rewardTopN;
  const exTopN = $('exTopN'); if (exTopN) exTopN.textContent = cfg.rewardTopN;
  const exRm = $('exRoundMins'); if (exRm) exRm.textContent = Math.round(cfg.roundSeconds / 60);
  (cfg.skins || []).forEach((s) => { if (s && s.img && s.emoji && !skinImages[s.emoji]) { const im = new Image(); im.src = s.img; skinImages[s.emoji] = im; } });
  buildSkinPicker(cfg.skins || []);
  const gate = $('gateNote');
  const exGate = $('exGate');
  if (cfg.demoMode) {
    gate.classList.add('demo');
    gate.innerHTML = '🟢 <b>Demo mode</b> — no token required. Paste any wallet to try it.';
    if (exGate) exGate.textContent = 'Free to play in demo mode — no token needed yet.';
  } else {
    gate.innerHTML =
      `🔒 Hold <b>${cfg.minTokenBalance.toLocaleString()}</b> tokens of ` +
      `<code>${shortMint(cfg.tokenMint)}</code> to play.`;
    if (exGate) exGate.textContent = `Hold ${cfg.minTokenBalance.toLocaleString()} of the ${shortMint(cfg.tokenMint)} token to play.`;
  }
  // Contract-address bar — appears as soon as a token mint is configured.
  const caBox = $('caBox');
  if (cfg.tokenMint) {
    $('caAddr').textContent = cfg.tokenMint;
    if (caBox) caBox.classList.remove('hidden');
  } else if (caBox) {
    caBox.classList.add('hidden');
  }
}).catch(() => {});

$('caCopy')?.addEventListener('click', () => {
  const addr = $('caAddr').textContent;
  if (!addr || !navigator.clipboard) return;
  navigator.clipboard.writeText(addr).then(() => {
    const b = $('caCopy');
    b.textContent = 'Copied!'; b.classList.add('copied');
    setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('copied'); }, 1500);
  }).catch(() => {});
});

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
  $('rbSub').textContent = `From creator fees · top ${serverConfig.rewardTopN} split 35/25/15/10/5% · ${d.rounds || 0} rounds paid`;
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
  // skins: [{color}, …, {color, emoji, name}]. Normalize legacy string entries.
  skins = skins.map((s) => (typeof s === 'string' ? { color: s } : s));
  const matches = (a, b) => a && b && a.color === b.color && (a.emoji || null) === (b.emoji || null);
  if (!selectedSkin || !skins.some((s) => matches(s, selectedSkin))) selectedSkin = skins[0];
  wrap.innerHTML = '';
  for (const s of skins) {
    const isChar = !!s.emoji;
    const sw = document.createElement('div');
    sw.className = 'swatch' + (isChar ? ' char' : '') + (s.img ? ' img' : '') + (matches(s, selectedSkin) ? ' sel' : '');
    sw.style.background = s.color;
    sw.style.color = s.color; // for the glow (currentColor)
    sw.title = s.name || s.color;
    if (s.img) { const im = document.createElement('img'); im.src = s.img; im.alt = s.name || ''; sw.appendChild(im); }
    else if (isChar) sw.textContent = s.emoji;
    sw.addEventListener('click', () => {
      selectedSkin = { color: s.color, emoji: s.emoji || null };
      saveSkin(selectedSkin);
      wrap.querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel'));
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

// ── Free spectate (no tokens, no slot) ──
$('watchBtn')?.addEventListener('click', startWatching);
function startWatching() {
  if (!socket) { socket = io(); wireSocket(); }
  socket.emit('watch');
  freeWatching = true;
  spectating = true; specTarget.has = false; specTarget.id = null;
  playing = false; pred.active = false; reconnectResume = false;
  $('lobby').classList.add('hidden');
  $('deathScreen').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('spectateBar').classList.remove('hidden');
  $('boostBtn').classList.add('hidden');
  $('playerBadge').classList.add('hidden');
  $('specNextBtn').classList.add('hidden');     // free watch follows the leader
  $('specRespawnBtn').textContent = '▶ Play';
  $('specName').textContent = 'leader';
  SFX.init();
}
function stopWatching() {
  freeWatching = false; spectating = false; specTarget.has = false;
  try { socket && socket.emit('unwatch'); } catch {}
  $('hud').classList.add('hidden');
  $('spectateBar').classList.add('hidden');
  $('boostBtn').classList.remove('hidden');
  $('specNextBtn').classList.remove('hidden');
  $('specRespawnBtn').textContent = 'Respawn';
  $('lobby').classList.remove('hidden');
}

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
  lastJoin = { name, wallet, color: selectedSkin && selectedSkin.color, skin: selectedSkin && selectedSkin.emoji };
  if (!socket) { socket = io(); wireSocket(); }
  socket.emit('join', lastJoin, (resp) => {
    if (!resp || !resp.ok) { $('joinError').textContent = (resp && resp.reason) || 'Could not join.'; resetBtn(); return; }
    myId = resp.playerId;
    world = resp.world || world;
    pred.name = name;
    if (selectedSkin && selectedSkin.color) pred.color = selectedSkin.color;
    pred.skin = (selectedSkin && selectedSkin.emoji) || null;
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

// Shown when the connection drops mid-game (almost always a deploy rolling out).
let updateCountdownTimer = null;
function showUpdateOverlay() {
  const ov = $('updateOverlay'); if (!ov) return;
  ov.classList.remove('hidden');
  let n = 20;
  const cd = $('updateCountdown'); if (cd) cd.textContent = n;
  clearInterval(updateCountdownTimer);
  updateCountdownTimer = setInterval(() => { n = Math.max(0, n - 1); if (cd) cd.textContent = n; }, 1000);
}
function hideUpdateOverlay() {
  const ov = $('updateOverlay'); if (ov) ov.classList.add('hidden');
  clearInterval(updateCountdownTimer);
}

function populatePlayerBadge() {
  const badge = $('playerBadge');
  if (!badge || !lastJoin) return;
  const c = (selectedSkin && selectedSkin.color) || pred.color;
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
    // Always trust the server's world bounds (self-corrects any stale/cached radius —
    // this is what kept making snakes render "outside" the boundary circle).
    if (s.world && s.world.radius) world.radius = s.world.radius;
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
    if (s.blips) latestBlips = s.blips;

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
      pred.immune = !!s.me.immune;
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
        // Snap the camera onto every fresh spawn — not just the first. Otherwise on
        // respawn the camera stays where you died (often at the wall) and slides over
        // slowly, making it look like you spawned outside the world.
        cam.x = pred.x; cam.y = pred.y; cam.init = true;
      }
    }
  });

  socket.on('dead', (info) => {
    playing = false;
    pred.active = false;
    prevLen = null;
    SFX.stopBoost();
    SFX.death();
    if (dmActive) {
      // Death Match: no respawn — you're out, auto-spectate the survivors.
      showToast("☠️ You're out — last snake standing wins it. Spectating…");
      enterSpectate();
      return;
    }
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
  socket.on('multikill', (m) => showMultiKill(m.streak));
  socket.on('roundStarted', (st) => updateRoundUI(st));
  socket.on('arenaReset', () => {
    // Server wiped the board — reseed local prediction so we snap cleanly to the
    // fresh spawn (and the camera re-centers) on the next state.
    pred.active = false; prevLen = null; buffer.length = 0;
    if (playing) showToast('🔄 Arena wiped — fresh start, everyone reset!');
  });
  socket.on('gateLost', (info) => {
    // Server kicked us — wallet no longer holds enough tokens. Back to lobby, no auto-rejoin.
    sendToLobbyWithError((info && info.reason) || 'You no longer hold enough tokens to play.');
  });
  socket.on('duplicate', (info) => {
    // This wallet joined elsewhere — only one session per wallet allowed.
    sendToLobbyWithError((info && info.reason) || 'This wallet is already playing on another device.');
  });

  // Creator-fee claim → payout flow (fires ~10s before round end).
  socket.on('claiming', () => {
    if (playing || spectating) showToast('💰 Claiming creator rewards…');
  });
  socket.on('claimed', (d) => {
    if ((playing || spectating) && d && d.sol > 0) {
      showToast(`Claimed ◎${(+d.sol).toFixed(4)} — paying out top ${serverConfig.rewardTopN}…`);
    }
  });
  socket.on('payout', (d) => {
    if (d && d.results) {
      const sent = d.results.filter((r) => r.sig).length;
      if ((playing || spectating) && sent) showToast(`✅ Rewards sent to ${sent} winner${sent === 1 ? '' : 's'}!`);
    }
    fetchRewards(); // refresh the lobby "rewards sent" total + top earners
  });

  // ── Death Match ──
  socket.on('deathMatchStart', () => {
    dmActive = true;
    SFX.deathMatch();   // ominous klaxon — unmistakable audio cue
    flashDeathMatch();  // hard red screen flash
    showDmBanner('☠️ DEATH MATCH',
      'Last snake alive wins the WHOLE pot — the ring is closing in, stay inside it!', 6000);
    if (playing || spectating) showToast('⚔️ Death Match! No respawns — last snake standing takes it all.');
    // If we're sitting on the death screen when the DM kicks off, we didn't make the
    // cut — slide into spectate instead of staring at a Respawn button that won't work.
    if (!playing && !spectating && !$('deathScreen').classList.contains('hidden')) {
      enterSpectate();
    }
  });
  socket.on('deathMatchEnd', (d) => {
    dmActive = false;
    const name = (d && d.winner && d.winner.name) || null;
    const sol = (d && d.sol) || 0;
    if (name) {
      const prize = sol > 0 ? ` — +${fmtSol(sol)} SOL!` : '!';
      showDmBanner('👑 ' + name + ' WINS', 'Last snake standing' + prize + ' Back to the regular game…', 6500);
      spawnConfetti(180);
    } else {
      showDmBanner('Death Match over', 'No winner this round — back to the regular game…', 4000);
    }
    fetchRewards();
  });

  // ── Connection status + auto-reconnect ──
  socket.on('connect', () => {
    setConn(true);
    hideUpdateOverlay(); // back online — clear the "update pushing" screen
    if (freeWatching) socket.emit('watch'); // re-subscribe a free spectator after reconnect
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
    // Mid-game drop is almost always a deploy rolling out — show the update screen
    // and auto-reconnect (socket.io keeps retrying; ~20s covers a Railway redeploy).
    if (playing || spectating) { reconnectResume = true; showUpdateOverlay(); }
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

// Kicked / gate lost: tear down to the lobby and surface why (no auto-rejoin).
function sendToLobbyWithError(msg) {
  reconnectResume = false;
  playing = false; spectating = false; pred.active = false; specTarget.has = false;
  $('hud').classList.add('hidden');
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.add('hidden');
  $('playerBadge').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('joinError').textContent = msg || '';
}

function doRespawn() {
  if (dmActive) {
    // No respawns during a Death Match — keep them spectating instead of dumping to lobby.
    showToast('☠️ Death Match in progress — no respawns. The next game starts right after!');
    return;
  }
  socket.emit('respawn', {}, (resp) => {
    if (resp && resp.ok) {
      myId = resp.playerId;
      pred.active = false; prevLen = null; buffer.length = 0;
      spectating = false; specTarget.has = false;
      $('spectateBar').classList.add('hidden');
      startPlaying();
    } else if (resp && resp.reason) {
      sendToLobbyWithError(resp.reason); // e.g. no longer holding enough tokens
    }
  });
}

$('respawnBtn').addEventListener('click', doRespawn);
// In free-watch mode this button is "▶ Play" → go to lobby to set up; otherwise respawn.
$('specRespawnBtn').addEventListener('click', () => { if (freeWatching) stopWatching(); else doRespawn(); });

function enterSpectate() {
  spectating = true; specTarget.has = false; specTarget.id = null;
  socket.emit('spectate');
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.remove('hidden');
}
$('spectateBtn').addEventListener('click', enterSpectate);

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
  dmActive = !!round.deathMatch;
  if (dmActive) {
    // During a Death Match the round pill shows the mode, not a countdown.
    $('roundTimer').textContent = '☠️ LAST SNAKE';
    $('roundPill').classList.add('urgent', 'dm');
    // Keep the red danger vignette glowing + a big flashing DEATH MATCH badge up for the
    // WHOLE match (vignette is auto-pulsed in the rAF loop), so it's unmistakable.
    const inGame = !$('hud').classList.contains('hidden');
    const vig = $('urgentVignette');
    if (vig) vig.classList.toggle('hidden', !inGame);
    $('dmLiveBadge').classList.toggle('hidden', !inGame);
    return;
  }
  // Not a Death Match — make sure its indicators are cleared.
  $('roundPill').classList.remove('dm');
  $('dmLiveBadge').classList.add('hidden');
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
    const reward = w.sol != null ? `${fmtSol(w.sol)} SOL` : `${w.score}`;
    li.innerHTML =
      `<span class="medal">${MEDALS[i] || '🏅'}</span>` +
      `<span class="rw-name">${escapeHtml(w.name)}</span>` +
      `<span class="rw-score">${reward}</span>`;
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

const MK_NAMES = { 2: 'DOUBLE KILL!', 3: 'TRIPLE KILL!', 4: 'QUAD KILL!', 5: 'PENTA KILL!' };
let mkTimer = null;
function showMultiKill(streak) {
  const el = $('multiKill');
  if (!el) return;
  el.textContent = MK_NAMES[streak] || `MULTI KILL ×${streak}!`;
  el.classList.remove('hidden');
  // restart the pop animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  SFX.streak(streak);
  clearTimeout(mkTimer);
  mkTimer = setTimeout(() => el.classList.add('hidden'), 1500);
}

let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

function flashDeathMatch() {
  const f = $('dmFlash');
  if (!f) return;
  f.classList.remove('flash');
  void f.offsetWidth; // reflow so the animation restarts even on back-to-back triggers
  f.classList.add('flash');
}

let dmBannerTimer = null;
function showDmBanner(title, sub, ms) {
  $('dmTitle').textContent = title;
  $('dmSub').textContent = sub;
  const ov = $('dmOverlay');
  ov.classList.remove('hidden');
  clearTimeout(dmBannerTimer);
  dmBannerTimer = setTimeout(() => ov.classList.add('hidden'), ms || 5000);
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
      immune: b.immune, sk: b.sk,
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
  // Crown ONLY the current #1 on the leaderboard (single global king). Shows when
  // they're on your screen.
  const crownId = leaderboardData.length ? leaderboardData[0].id : null;

  for (const sn of remotes) {
    if (sn.immune) ctx.globalAlpha = 0.45 + 0.25 * Math.sin(performance.now() / 120);
    drawSnake(sn.segs, sn.x, sn.y, sn.a, sn.r, sn.color, sn.name, sn.boosting, sn.sk);
    ctx.globalAlpha = 1;
    if (sn.immune) drawShield(sn.x, sn.y, sn.r);
    if (sn.id === crownId) drawCrown(sn.x, sn.y, sn.r);
  }
  if (pred.active) {
    if (pred.immune) ctx.globalAlpha = 0.5 + 0.25 * Math.sin(performance.now() / 120);
    drawSnake(pred.trail.map((p) => [p.x, p.y]), pred.x, pred.y, pred.a, bodyRadius(pred.length), pred.color, pred.name, isBoosting, pred.skin);
    ctx.globalAlpha = 1;
    if (pred.immune) drawShield(pred.x, pred.y, bodyRadius(pred.length));
    if (myId === crownId) drawCrown(pred.x, pred.y, bodyRadius(pred.length));
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
    // Chunky +5 orbs (big radius) get a pulsing ring so they read as a prize.
    if (r >= 10) {
      const pulse = 1.25 + Math.sin(performance.now() / 220) * 0.18;
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r * pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

// One stroked tube + one inner highlight + head + eyes + name.
function drawSnake(points, hx, hy, a, r, color, name, isBoost, skin) {
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
  if (skin) {
    const img = skinImages[skin];
    if (img) {
      // Image skin (e.g. The DUVE) — draw the artwork on the head once it's loaded.
      if (img.complete && img.naturalWidth) {
        const d = r * 2.8;
        ctx.drawImage(img, hx - d / 2, hy - d / 2, d, d);
      }
    } else {
      // Emoji skin — draw the emoji "face".
      ctx.font = `${Math.round(r * 2.4)}px "Segoe UI Emoji", "Apple Color Emoji", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(skin, hx, hy);
      ctx.textBaseline = 'alphabetic';
    }
  } else {
    drawEyes(hx, hy, a, r);
  }

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

// Cyan shield ring around an immune snake's head (spawn / arena-reset grace).
function drawShield(hx, hy, r) {
  const pulse = 1.5 + Math.sin(performance.now() / 110) * 0.2;
  ctx.save();
  ctx.strokeStyle = 'rgba(120,220,255,0.85)';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = '#7CC8FF';
  ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(hx, hy, r * pulse, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// Gold crown worn by the current #1 snake — sits just on top of the head.
function drawCrown(hx, hy, r) {
  const w = Math.max(18, r * 1.7);
  const h = w * 0.6;
  const bot = hy - r - 2;            // rest it just above the head
  const top = bot - h;
  const midY = bot - h * 0.42;
  const cx = hx, left = hx - w / 2, right = hx + w / 2;
  ctx.save();
  ctx.shadowColor = '#FFD166';
  ctx.shadowBlur = 8;
  ctx.fillStyle = '#FFD54A';
  ctx.beginPath();
  ctx.moveTo(left, bot);
  ctx.lineTo(left, top + h * 0.18);          // left spike
  ctx.lineTo(left + w * 0.28, midY);          // valley
  ctx.lineTo(cx, top - h * 0.12);             // tallest center spike
  ctx.lineTo(right - w * 0.28, midY);         // valley
  ctx.lineTo(right, top + h * 0.18);          // right spike
  ctx.lineTo(right, bot);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(120,80,0,0.7)';
  ctx.stroke();
  // center ruby
  ctx.fillStyle = '#FF4D6D';
  ctx.beginPath(); ctx.arc(cx, top + h * 0.1, Math.max(1.5, r * 0.14), 0, Math.PI * 2); ctx.fill();
  ctx.restore();
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

  // Every alive snake in the world (server blips) — so the minimap shows the whole arena,
  // not just what's on screen.
  mctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (const b of latestBlips) {
    const [mx, my] = toMap(b[0], b[1]);
    mctx.beginPath(); mctx.arc(mx, my, 1.6, 0, Math.PI * 2); mctx.fill();
  }
  // Nearby snakes get their real color painted on top.
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
