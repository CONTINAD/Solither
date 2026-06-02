// ─────────────────────────────────────────────────────────────
// Solither game engine — server-authoritative slither simulation.
// ─────────────────────────────────────────────────────────────

export const WORLD = { radius: 2600 };

// Shared with the client for prediction — keep in sync with the constants below.
export const SIM = {
  tickRate: 30,
  baseSpeed: 3.9,
  boostSpeed: 7.4,
  turnRate: 0.24,
  pointSpacing: 4,
  startLength: 20,
  minBoostLength: 12,
  worldRadius: 2600,
};

const TICK_RATE = 30;            // simulation steps per second
const BASE_SPEED = 3.9;          // units per tick at normal speed
const BOOST_SPEED = 7.4;         // units per tick while boosting
const TURN_RATE = 0.24;          // max radians the head can turn per tick
const START_LENGTH = 20;         // initial number of trail points
const POINT_SPACING = 4;         // distance between recorded trail points
const SEGMENT_EVERY = 5;         // render a body circle every N trail points
const FOOD_TARGET = 600;         // number of food pellets kept in the world
const BOT_TARGET = 8;            // bots kept alive to fill the arena
const BOOST_COST_TICKS = 6;      // lose 1 length every this many ticks while boosting
const MIN_BOOST_LENGTH = 12;     // can't boost below this length

let nextId = 1;
const colors = [
  '#14F195', '#9945FF', '#00D1FF', '#FF4D6D', '#FFD166',
  '#06FFA5', '#F72585', '#4CC9F0', '#FB8500', '#B5179E',
];

function rand(min, max) { return min + Math.random() * (max - min); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function clampToWorld(x, y) {
  const d = Math.hypot(x, y);
  if (d <= WORLD.radius) return { x, y, hitWall: false };
  const k = WORLD.radius / d;
  return { x: x * k, y: y * k, hitWall: true };
}

export class Game {
  constructor() {
    this.players = new Map(); // id -> player
    this.food = [];
    this.tick = 0;
    for (let i = 0; i < FOOD_TARGET; i++) this.food.push(this.spawnFood());
    this.onDeath = null; // optional callback(player)
  }

  spawnFood(x, y, value = 1, color = null) {
    if (x === undefined) {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * (WORLD.radius - 30);
      x = Math.cos(a) * r;
      y = Math.sin(a) * r;
    }
    return {
      x, y,
      value,
      color: color || (Math.random() < 0.12 ? '#9945FF' : '#14F195'),
      r: value > 1 ? 7 : 5,
    };
  }

  randomSpawnPoint() {
    const a = rand(0, Math.PI * 2);
    const r = Math.sqrt(Math.random()) * (WORLD.radius * 0.7);
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  }

  addPlayer({ name, wallet, isBot = false, socketId = null }) {
    const id = nextId++;
    const { x, y } = this.randomSpawnPoint();
    const angle = rand(0, Math.PI * 2);
    const trail = [];
    for (let i = 0; i < START_LENGTH; i++) {
      trail.push({ x: x - Math.cos(angle) * i * POINT_SPACING, y: y - Math.sin(angle) * i * POINT_SPACING });
    }
    const player = {
      id,
      name: (name || 'Anon').slice(0, 16),
      wallet: wallet || null,
      isBot,
      socketId,
      x, y, angle,
      targetAngle: angle,
      trail,
      length: START_LENGTH,
      score: 0,
      boosting: false,
      alive: true,
      color: colors[id % colors.length],
      radius: 12,
      // stats
      kills: 0,
      peakLength: START_LENGTH,
      spawnAt: Date.now(),
      // bot ai memory
      _wander: angle,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  setInput(id, { targetAngle, boosting }) {
    const p = this.players.get(id);
    if (!p || !p.alive || p.isBot) return;
    if (typeof targetAngle === 'number' && Number.isFinite(targetAngle)) p.targetAngle = targetAngle;
    if (typeof boosting === 'boolean') p.boosting = boosting;
  }

  bodyRadius(p) {
    // Snakes get visually thicker as they grow.
    return 11 + Math.min(18, p.length / 60);
  }

  step() {
    this.tick++;

    // Keep the arena populated with bots.
    let botCount = 0;
    for (const p of this.players.values()) if (p.isBot && p.alive) botCount++;
    while (botCount < BOT_TARGET) {
      this.addPlayer({ name: this.botName(), isBot: true });
      botCount++;
    }

    // Top up food.
    while (this.food.length < FOOD_TARGET) this.food.push(this.spawnFood());

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.isBot) this.botThink(p);
      this.movePlayer(p);
    }

    this.handleFood();
    this.handleCollisions();
  }

  movePlayer(p) {
    // Smoothly steer toward target angle.
    let diff = p.targetAngle - p.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    diff = Math.max(-TURN_RATE, Math.min(TURN_RATE, diff));
    p.angle += diff;

    let speed = BASE_SPEED;
    if (p.boosting && p.length > MIN_BOOST_LENGTH) {
      speed = BOOST_SPEED;
      if (this.tick % BOOST_COST_TICKS === 0) {
        p.length -= 1;
        // Drop a pellet behind as you burn length.
        const tail = p.trail[p.trail.length - 1];
        if (tail) this.food.push(this.spawnFood(tail.x, tail.y, 1, p.color));
      }
    } else {
      p.boosting = false;
    }

    let nx = p.x + Math.cos(p.angle) * speed;
    let ny = p.y + Math.sin(p.angle) * speed;
    const clamped = clampToWorld(nx, ny);
    p.x = clamped.x;
    p.y = clamped.y;
    if (clamped.hitWall && !p.isBot) {
      // Players die on the wall; bots bounce to stay alive.
    }
    if (clamped.hitWall) {
      if (p.isBot) {
        p.angle += Math.PI; // turn around
        p.targetAngle = p.angle;
      } else {
        this.kill(p, 'wall');
        return;
      }
    }

    // Record trail.
    p.trail.unshift({ x: p.x, y: p.y });
    const maxPoints = Math.max(START_LENGTH, Math.floor(p.length));
    while (p.trail.length > maxPoints) p.trail.pop();
  }

  handleFood() {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const eatR = this.bodyRadius(p) + 10;
      const eatR2 = eatR * eatR;
      for (let i = this.food.length - 1; i >= 0; i--) {
        const f = this.food[i];
        if (dist2(p.x, p.y, f.x, f.y) <= eatR2) {
          p.length += f.value;
          p.score += f.value;
          if (p.length > p.peakLength) p.peakLength = p.length;
          this.food.splice(i, 1);
        }
      }
    }
  }

  // Returns body sample points for a player (used for collision + render).
  bodySamples(p) {
    const pts = [];
    for (let i = 0; i < p.trail.length; i += SEGMENT_EVERY) pts.push(p.trail[i]);
    return pts;
  }

  handleCollisions() {
    const alive = [...this.players.values()].filter((p) => p.alive);
    for (const p of alive) {
      const headR = this.bodyRadius(p);
      for (const o of alive) {
        if (o.id === p.id) continue;
        const oR = this.bodyRadius(o);
        const hitDist = headR + oR;
        const hit2 = hitDist * hitDist;
        // Skip the first few segments of the other snake (its own head area).
        const samples = o.trail;
        for (let i = 6; i < samples.length; i += SEGMENT_EVERY) {
          const s = samples[i];
          if (dist2(p.x, p.y, s.x, s.y) <= hit2) {
            this.kill(p, 'collision', o);
            break;
          }
        }
        if (!p.alive) break;
      }
    }
  }

  kill(p, cause, killer = null) {
    if (!p.alive) return;
    p.alive = false;
    // Scatter the snake's body into food.
    for (let i = 0; i < p.trail.length; i += 3) {
      const s = p.trail[i];
      if (Math.random() < 0.7) {
        this.food.push(this.spawnFood(s.x + rand(-8, 8), s.y + rand(-8, 8), 2, p.color));
      }
    }
    if (killer) { killer.score += Math.floor(p.score * 0.5); killer.kills += 1; }

    if (this.onDeath) this.onDeath(p, cause, killer);

    if (p.isBot) {
      this.players.delete(p.id);
    }
    // Human players are kept (alive=false) so the client can show a death screen,
    // then removed/respawned on request.
  }

  respawn(id, name) {
    const old = this.players.get(id);
    if (!old) return null;
    this.players.delete(id);
    return this.addPlayer({
      name: name || old.name,
      wallet: old.wallet,
      socketId: old.socketId,
    });
  }

  botThink(p) {
    // Wander with gentle steering, avoid the wall, chase nearby food, flee bigger snakes.
    const distFromCenter = Math.hypot(p.x, p.y);

    // Steer back toward center if near the edge.
    if (distFromCenter > WORLD.radius * 0.82) {
      p.targetAngle = Math.atan2(-p.y, -p.x) + rand(-0.3, 0.3);
      return;
    }

    // Occasionally pick a new wander direction.
    if (this.tick % 18 === 0 || Math.random() < 0.02) {
      p._wander += rand(-0.6, 0.6);
    }
    p.targetAngle = p._wander;

    // Look for the nearest food in a cone and drift toward it.
    let best = null, bestD = 350 * 350;
    for (const f of this.food) {
      const d = dist2(p.x, p.y, f.x, f.y);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best) {
      p.targetAngle = Math.atan2(best.y - p.y, best.x - p.x);
      p._wander = p.targetAngle;
    }

    p.boosting = false;
  }

  botName() {
    const a = ['Degen', 'Whale', 'Ser', 'Anon', 'Chad', 'Frog', 'Bonk', 'Sol', 'Gm', 'Wagmi', 'Ngmi', 'Ape'];
    const b = ['Maxi', 'Bot', 'Snek', 'Slug', 'King', 'Fren', 'Pump', '420', '69', 'XBT', 'Moon'];
    return a[Math.floor(Math.random() * a.length)] + b[Math.floor(Math.random() * b.length)];
  }

  // Build a snapshot to send to a particular player (culled to their view).
  snapshotFor(player) {
    const view = 1400; // half-width of what we send around the player
    const cx = player ? player.x : 0;
    const cy = player ? player.y : 0;
    const view2 = view * view;

    const snakes = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      // Cull snakes whose head is far away (cheap; bodies can poke in slightly).
      if (player && dist2(cx, cy, p.x, p.y) > (view + 600) * (view + 600)) continue;
      const segs = [];
      const samples = this.bodySamples(p);
      for (const s of samples) segs.push([Math.round(s.x), Math.round(s.y)]);
      snakes.push({
        id: p.id,
        name: p.name,
        color: p.color,
        r: Math.round(this.bodyRadius(p)),
        score: p.score,
        boosting: p.boosting,
        x: Math.round(p.x),
        y: Math.round(p.y),
        a: Number(p.angle.toFixed(2)),
        segs,
      });
    }

    const food = [];
    for (const f of this.food) {
      if (dist2(cx, cy, f.x, f.y) > view2) continue;
      food.push([Math.round(f.x), Math.round(f.y), f.r, f.color]);
    }

    return { snakes, food, world: WORLD };
  }

  // 1-based rank of a player by score among everyone currently in the game.
  rankOf(player) {
    let rank = 1;
    for (const p of this.players.values()) {
      if (p.id !== player.id && p.score > player.score) rank++;
    }
    return rank;
  }

  totalPlayers() { return this.players.size; }

  // Highest-scoring living snake — the default spectate target.
  topAliveSnake() {
    let best = null;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!best || p.score > best.score) best = p;
    }
    return best;
  }

  leaderboard(n = 10) {
    return [...this.players.values()]
      .filter((p) => p.alive)
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((p) => ({ id: p.id, name: p.name, score: p.score, isBot: p.isBot, wallet: p.wallet }));
  }

  get tickRate() { return TICK_RATE; }
}
