import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

import { config, DEMO_MODE } from './config.js';
import { verifyWallet, invalidateWallet } from './solana.js';
import { Game, SIM, SKINS } from './game.js';
import { RoundManager } from './rewards.js';
import { recordScore, topScores, resetScores } from './highscores.js';
import { rewardsSummary, resetLedger } from './rewardsLedger.js';
import { payoutWinners, claimFees } from './payout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5,   // cap inbound message size (anti-abuse)
  connectTimeout: 20000,
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(express.json());
// no-cache + revalidate so deploys reach players without a manual hard-refresh
// (ETag/Last-Modified still give cheap 304s; only changed files re-download).
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// Expose public config so the client can show gating rules.
app.get('/api/config', (req, res) => {
  res.json({
    demoMode: DEMO_MODE,
    tokenMint: config.tokenMint || null,
    minTokenBalance: config.minTokenBalance,
    roundSeconds: config.roundSeconds,
    rewardTopN: config.rewardTopN,
    maxPlayers: config.maxPlayers,
    sim: SIM,
    skins: SKINS,
  });
});

// REST pre-check so the join screen can validate before opening a socket.
app.post('/api/verify', async (req, res) => {
  const { wallet } = req.body || {};
  const result = await verifyWallet(wallet);
  res.json(result);
});

app.get('/api/rounds', (req, res) => {
  res.json(rounds.history.slice(-10).reverse());
});

app.get('/api/highscores', (req, res) => {
  res.json(topScores());
});

app.get('/api/rewards', (req, res) => {
  res.json({ ...rewardsSummary(10), roundPoolSol: config.rewardPoolSol });
});

// ── Game + rounds ────────────────────────────────────────────
const game = new Game();
const rounds = new RoundManager(game, io);
rounds.payoutHook = payoutWinners; // sends SOL to winners when PAYOUT_ENABLED (else record-only)
rounds.feeClaimHook = claimFees;   // claims pump.fun creator fees ~10s before round end

// One-shot wipe of all persisted stats. Set RESET_STATS=1 on the server, deploy once,
// then set it back to 0 (otherwise every deploy re-wipes).
if (process.env.RESET_STATS === '1') {
  resetScores();
  resetLedger();
  rounds.resetRounds();
  console.log('[Solither] RESET_STATS=1 — wiped high scores, rewards ledger, and rounds.');
}

const socketByPlayerId = new Map(); // playerId -> socket
const spectating = new Map();       // spectator playerId -> watched targetId (null = auto/leader)
const walletSocket = new Map();     // wallet -> socket (enforces one active session per wallet)

// ── Abuse / flood guardrails ──
const connsByIp = new Map();        // ip -> live connection count
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP) || 6;
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MS) || 20000; // drop sockets that never join
const clientIp = (s) => {
  const f = s.handshake.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : s.handshake.address) || 'unknown';
};

game.onDeath = (player, cause, killer) => {
  // Global kill-feed event for collision kills (includes bots — it's fun to read).
  if (cause === 'collision' && killer) {
    io.emit('kill', {
      killer: killer.name, killerId: killer.id,
      victim: player.name, victimId: player.id,
    });
    // Multi-kill streak juice for human killers.
    if (!killer.isBot && killer.killStreak >= 2) {
      const ks = socketByPlayerId.get(killer.id);
      if (ks) ks.emit('multikill', { streak: killer.killStreak });
    }
  }
  if (player.isBot) return;
  // Record the finished run on the all-time board.
  recordScore(player.name, player.score, player.wallet);
  const sock = socketByPlayerId.get(player.id);
  if (sock) {
    sock.emit('dead', {
      cause,
      score: player.score,
      killedBy: killer ? killer.name : null,
      peakLength: Math.floor(player.peakLength),
      kills: player.kills,
      survivalMs: Date.now() - player.spawnAt,
      rank: game.rankOf(player),
      totalPlayers: game.totalPlayers(),
    });
  }
};

// ── Socket handling ──────────────────────────────────────────
io.on('connection', (socket) => {
  // ── Per-IP connection cap (flood guard). Track + decrement first so it's accurate
  // even when we drop the socket below. ──
  const ip = clientIp(socket);
  connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1);
  socket.on('disconnect', () => {
    const c = (connsByIp.get(ip) || 1) - 1;
    if (c <= 0) connsByIp.delete(ip); else connsByIp.set(ip, c);
  });
  if (connsByIp.get(ip) > MAX_CONNS_PER_IP) { socket.disconnect(true); return; }

  let playerId = null;
  let joinedWallet = null; // wallet this socket joined with (for one-session-per-wallet cleanup)
  // Drop sockets that connect but never join (idle connection floods).
  let idleTimer = setTimeout(() => { if (playerId == null) socket.disconnect(true); }, JOIN_TIMEOUT_MS);

  // ── Per-socket rate limiting ──
  let inputCount = 0, inputWindow = Date.now();
  const cooldowns = {};
  const onCooldown = (key, ms) => {
    const now = Date.now();
    if (cooldowns[key] && now - cooldowns[key] < ms) return true;
    cooldowns[key] = now;
    return false;
  };

  socket.on('join', async ({ wallet, name, color }, ack) => {
    if (onCooldown('join', 1000)) { ack?.({ ok: false, reason: 'Slow down a moment and try again.' }); return; }
    // Capacity guard — keep the arena within the configured player cap.
    if (playerId == null && socketByPlayerId.size >= config.maxPlayers) {
      ack?.({ ok: false, reason: `Arena is full (${config.maxPlayers} players). Try again in a moment.` });
      return;
    }
    const result = await verifyWallet(wallet);
    if (!result.ok) {
      ack?.({ ok: false, reason: result.reason });
      return;
    }
    // One active session per wallet: if this wallet is already playing on another
    // socket, kick that one (handles a 2nd tab/device, and stale reconnects).
    const wkey = (wallet || '').trim();
    if (wkey) {
      const prev = walletSocket.get(wkey);
      if (prev && prev !== socket) {
        prev.emit('duplicate', { reason: 'This wallet is now playing on another device.' });
        setTimeout(() => { try { prev.disconnect(true); } catch {} }, 120);
      }
      walletSocket.set(wkey, socket);
      joinedWallet = wkey;
    }
    const player = game.addPlayer({
      name: name,
      wallet: wkey || null,
      socketId: socket.id,
      color,
    });
    playerId = player.id;
    socketByPlayerId.set(playerId, socket);
    clearTimeout(idleTimer); // joined — no longer idle
    ack?.({
      ok: true,
      playerId,
      balance: result.balance,
      world: { radius: SIM.worldRadius },
      round: rounds.status(),
    });
  });

  socket.on('input', (data) => {
    // Cap at ~60 inputs/sec per socket; drop excess to prevent flooding.
    const now = Date.now();
    if (now - inputWindow >= 1000) { inputWindow = now; inputCount = 0; }
    if (++inputCount > 60) return;
    if (playerId != null) game.setInput(playerId, data || {});
  });

  socket.on('spectate', (data) => {
    if (playerId == null || onCooldown('spectate', 250)) return;
    // data.targetId picks a specific snake to watch; null/absent = auto-follow the leader.
    spectating.set(playerId, (data && data.targetId) || null);
  });

  socket.on('respawn', async (_, ack) => {
    if (playerId == null) { ack?.({ ok: false }); return; }
    if (onCooldown('respawn', 400)) { ack?.({ ok: false }); return; }
    // Re-check holdings on every new life — you can't keep respawning if you no longer hold.
    const cur = game.players.get(playerId);
    if (cur && cur.wallet) {
      const res = await verifyWallet(cur.wallet);
      if (!res.ok) { ack?.({ ok: false, reason: res.reason || 'You no longer hold enough tokens to play.' }); return; }
    }
    spectating.delete(playerId);
    const np = game.respawn(playerId, undefined);
    if (!np) { ack?.({ ok: false }); return; }
    socketByPlayerId.delete(playerId);
    playerId = np.id;
    socketByPlayerId.set(playerId, socket);
    ack?.({ ok: true, playerId, round: rounds.status() });
  });

  socket.on('disconnect', () => {
    // Release this wallet's session lock only if we still hold it (not if it was
    // already taken over by a newer socket for the same wallet).
    clearTimeout(idleTimer);
    if (joinedWallet && walletSocket.get(joinedWallet) === socket) walletSocket.delete(joinedWallet);
    if (playerId != null) {
      socketByPlayerId.delete(playerId);
      spectating.delete(playerId);
      game.removePlayer(playerId);
      playerId = null;
    }
  });
});

// ── Simulation loop ──────────────────────────────────────────
const TICK_MS = 1000 / game.tickRate;
setInterval(() => {
  game.step();
  rounds.tick();
}, TICK_MS);

// ── Network broadcast loop (lower rate than sim to save bandwidth) ──
const NET_HZ = Number(process.env.NET_HZ) || 10;
setInterval(() => {
  const lb = game.leaderboard(10);
  const roundStatus = rounds.status();
  const humans = countHumans();
  const frame = game.buildFrame(); // built ONCE per tick, shared across all viewers
  // Global minimap blips + rank map — computed ONCE per broadcast (was O(n^2) via rankOf
  // per socket). One sorted pass gives every player's rank + the blips.
  const blips = [];
  const alivePlayers = [];
  for (const p of game.players.values()) if (p.alive) { blips.push([Math.round(p.x), Math.round(p.y)]); alivePlayers.push(p); }
  alivePlayers.sort((a, b) => b.score - a.score);
  const rankMap = new Map();
  for (let i = 0; i < alivePlayers.length; i++) rankMap.set(alivePlayers[i].id, i + 1);
  const nowMs = Date.now();
  for (const [pid, socket] of socketByPlayerId) {
    const player = game.players.get(pid);
    if (!player) continue;

    // When a dead player is spectating, re-center the snapshot on their watched target
    // (or the live leader if no target / the target died).
    let center = player;
    let spectate = null;
    if (!player.alive && spectating.has(pid)) {
      const targetId = spectating.get(pid);
      let target = targetId != null ? game.players.get(targetId) : null;
      if (!target || !target.alive) {
        target = game.topAliveSnake();
        spectating.set(pid, target ? target.id : null);
      }
      if (target) {
        center = target;
        spectate = { id: target.id, x: Math.round(target.x), y: Math.round(target.y), name: target.name, score: target.score };
      }
    }

    socket.emit('state', {
      me: player.alive
        ? { id: player.id, x: Math.round(player.x), y: Math.round(player.y), a: Number(player.angle.toFixed(3)), boosting: player.boosting, score: player.score, length: Math.floor(player.length), alive: true, rank: rankMap.get(player.id) || 1, coiling: player.coiling, immune: nowMs < (player.immuneUntil || 0) }
        : { id: player.id, alive: false, score: player.score },
      ...game.cullFrameFor(frame, Math.round(center.x), Math.round(center.y)),
      spectate,
      blips,
      leaderboard: lb,
      round: roundStatus,
      players: humans,
    });
  }
}, 1000 / NET_HZ);

// Continuous token-gate enforcement: periodically re-verify that each connected player
// STILL holds enough tokens, and kick anyone who sold or transferred them away.
// No-op in demo mode (verifyWallet always passes). Forces a fresh on-chain read.
if (!DEMO_MODE) {
  const RECHECK_MS = 90_000;
  setInterval(async () => {
    for (const [pid, sock] of socketByPlayerId) {
      const player = game.players.get(pid);
      if (!player || player.isBot || !player.wallet) continue;
      invalidateWallet(player.wallet);
      const res = await verifyWallet(player.wallet);
      if (!res.ok) {
        sock.emit('gateLost', { reason: res.reason || 'You no longer hold enough tokens to play.' });
        setTimeout(() => sock.disconnect(true), 200);
      }
    }
  }, RECHECK_MS);
}

function countHumans() {
  let n = 0;
  for (const p of game.players.values()) if (!p.isBot && p.alive) n++;
  return n;
}

server.listen(config.port, () => {
  console.log(`\n  🐍  Solither running →  http://localhost:${config.port}\n`);
  console.log(`  Round length: ${config.roundSeconds}s · Rewards: top ${config.rewardTopN}`);
});
