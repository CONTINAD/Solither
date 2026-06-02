import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

import { config, DEMO_MODE } from './config.js';
import { verifyWallet } from './solana.js';
import { Game, SIM, SKINS } from './game.js';
import { RoundManager } from './rewards.js';
import { recordScore, topScores } from './highscores.js';
import { rewardsSummary } from './rewardsLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Expose public config so the client can show gating rules.
app.get('/api/config', (req, res) => {
  res.json({
    demoMode: DEMO_MODE,
    tokenMint: config.tokenMint || null,
    minTokenBalance: config.minTokenBalance,
    roundSeconds: config.roundSeconds,
    rewardTopN: config.rewardTopN,
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

const socketByPlayerId = new Map(); // playerId -> socket
const spectating = new Set();       // playerIds currently spectating (dead, watching #1)

game.onDeath = (player, cause, killer) => {
  // Global kill-feed event for collision kills (includes bots — it's fun to read).
  if (cause === 'collision' && killer) {
    io.emit('kill', {
      killer: killer.name, killerId: killer.id,
      victim: player.name, victimId: player.id,
    });
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
  let playerId = null;

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
    const player = game.addPlayer({
      name: name,
      wallet: (wallet || '').trim() || null,
      socketId: socket.id,
      color,
    });
    playerId = player.id;
    socketByPlayerId.set(playerId, socket);
    ack?.({
      ok: true,
      playerId,
      balance: result.balance,
      world: { radius: 2600 },
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

  socket.on('spectate', () => {
    if (playerId != null && !onCooldown('spectate', 400)) spectating.add(playerId);
  });

  socket.on('respawn', (_, ack) => {
    if (playerId == null) { ack?.({ ok: false }); return; }
    if (onCooldown('respawn', 400)) { ack?.({ ok: false }); return; }
    spectating.delete(playerId);
    const np = game.respawn(playerId, undefined);
    if (!np) { ack?.({ ok: false }); return; }
    socketByPlayerId.delete(playerId);
    playerId = np.id;
    socketByPlayerId.set(playerId, socket);
    ack?.({ ok: true, playerId, round: rounds.status() });
  });

  socket.on('disconnect', () => {
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
const NET_HZ = 22;
setInterval(() => {
  const lb = game.leaderboard(10);
  const roundStatus = rounds.status();
  for (const [pid, socket] of socketByPlayerId) {
    const player = game.players.get(pid);
    if (!player) continue;

    // When a dead player is spectating, re-center the snapshot on the live leader.
    let center = player;
    let spectate = null;
    if (!player.alive && spectating.has(pid)) {
      const top = game.topAliveSnake();
      if (top) {
        center = top;
        spectate = { x: Math.round(top.x), y: Math.round(top.y), name: top.name, score: top.score };
      }
    }

    socket.emit('state', {
      me: player.alive
        ? { id: player.id, x: Math.round(player.x), y: Math.round(player.y), a: Number(player.angle.toFixed(3)), boosting: player.boosting, score: player.score, length: Math.floor(player.length), alive: true, rank: game.rankOf(player) }
        : { id: player.id, alive: false, score: player.score },
      ...game.snapshotFor(center),
      spectate,
      leaderboard: lb,
      round: roundStatus,
      players: countHumans(),
    });
  }
}, 1000 / NET_HZ);

function countHumans() {
  let n = 0;
  for (const p of game.players.values()) if (!p.isBot && p.alive) n++;
  return n;
}

server.listen(config.port, () => {
  console.log(`\n  🐍  Solither running →  http://localhost:${config.port}\n`);
  console.log(`  Round length: ${config.roundSeconds}s · Rewards: top ${config.rewardTopN}`);
});
