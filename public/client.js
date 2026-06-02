/* global io */
// ─────────────────────────────────────────────────────────────
// Solither client — client-side prediction + entity interpolation
// + a cheap, smooth stroked renderer. Designed to feel lag-free.
// ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

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
const fx = [];          // boost particles { x, y, vx, vy, life, max, r, color }
const pops = [];        // floating "+N" eat popups { x, y, vy, text, life, max, color }
let headFlashUntil = 0; // ms timestamp until which the local head flashes white
let prevLen = null;     // last server length, to detect eating

const cam = { x: 0, y: 0, init: false };

// Spectate: when dead and watching, follow the live leader's head.
let spectating = false;
const specTarget = { x: 0, y: 0, has: false };

// ── Load public config ───────────────────────────────────────
fetch('/api/config').then((r) => r.json()).then((cfg) => {
  serverConfig = cfg;
  if (cfg.sim) SIM = cfg.sim;
  world.radius = SIM.worldRadius;
  $('roundMins').textContent = Math.round(cfg.roundSeconds / 60);
  $('topNNote').textContent = cfg.rewardTopN;
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

fetch('/api/rounds').then((r) => r.json()).then(renderLastWinners).catch(() => {});

function shortMint(m) { return m ? m.slice(0, 4) + '…' + m.slice(-4) : ''; }

function renderLastWinners(history) {
  if (!history || !history.length) return;
  const last = history.find((h) => h.winners && h.winners.length);
  if (!last) return;
  const list = $('winnersList');
  list.innerHTML = '';
  for (const w of last.winners) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="w-name">#${w.rank} ${escapeHtml(w.name)}</span><span>${w.score}</span>`;
    list.appendChild(li);
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
  if (!socket) { socket = io(); wireSocket(); }
  socket.emit('join', { name, wallet }, (resp) => {
    if (!resp || !resp.ok) { $('joinError').textContent = (resp && resp.reason) || 'Could not join.'; resetBtn(); return; }
    myId = resp.playerId;
    world = resp.world || world;
    pred.name = name;
    pred.active = false;
    buffer.length = 0;
    startPlaying();
  });
}

function startPlaying() {
  playing = true;
  spectating = false; specTarget.has = false;
  $('lobby').classList.add('hidden');
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.add('hidden');
  $('hud').classList.remove('hidden');
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
      const nm = $('specName');
      if (nm) nm.textContent = s.spectate.name;
    }

    // Reconcile / seed local prediction.
    if (s.me && s.me.alive) {
      $('scoreVal').textContent = s.me.length || 0;
      // Detect eating (length up) for the "+N" pop + head flash.
      if (prevLen !== null && s.me.length > prevLen && pred.active) {
        const gain = s.me.length - prevLen;
        pops.push({ x: pred.x, y: pred.y - bodyRadius(pred.length) - 8, vy: -0.45, text: '+' + gain, life: 0, max: 750, color: pred.color });
        headFlashUntil = performance.now() + 150;
      }
      prevLen = s.me.length;
      pred.length = s.me.length || pred.length;
      pred.serverX = s.me.x; pred.serverY = s.me.y;
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
    if (record.winners && record.winners.length) {
      showToast(`🏆 Round ${record.round} winner: ${record.winners[0].name} — top ${serverConfig.rewardTopN} get creator rewards!`);
    } else {
      showToast(`Round ${record.round} ended.`);
    }
  });
  socket.on('kill', (k) => addKillFeed(k));
  socket.on('roundStarted', (st) => updateRoundUI(st));
  socket.on('disconnect', () => { if (playing) showToast('Disconnected from server.'); });
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
  spectating = true; specTarget.has = false;
  socket.emit('spectate');
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.remove('hidden');
});

$('quitBtn').addEventListener('click', () => {
  playing = false; pred.active = false;
  spectating = false; specTarget.has = false;
  $('deathScreen').classList.add('hidden');
  $('spectateBar').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  fetch('/api/rounds').then((r) => r.json()).then(renderLastWinners).catch(() => {});
});

// ── Round / leaderboard UI ───────────────────────────────────
function updateRoundUI(round) {
  if (!round) return;
  const sec = Math.ceil(round.msRemaining / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  $('roundTimer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('roundPill').classList.toggle('urgent', sec <= 15);
}

function updateLeaderboard(lb) {
  const list = $('lbList');
  list.innerHTML = '';
  lb.forEach((p, i) => {
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
window.addEventListener('keydown', (e) => { if (e.code === 'Space') boosting = true; });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') boosting = false; });
window.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('touchstart', (e) => { boosting = true; if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; } }, { passive: true });
window.addEventListener('touchmove', (e) => { if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; } }, { passive: true });
window.addEventListener('touchend', () => { boosting = false; });

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
    if (pred.trail.length > 1) {
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

function render(now) {
  requestAnimationFrame(render);
  const dt = now - lastFrame;
  lastFrame = now;

  predict(dt);
  updateFx(dt);

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

  updateBoostHud();

  drawMinimap(remotes);
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
