// ─────────────────────────────────────────────────────────────
// Solither game engine — server-authoritative slither simulation.
// ─────────────────────────────────────────────────────────────

export const WORLD = { radius: 4400 };

// Shared with the client for prediction — keep in sync with the constants below.
export const SIM = {
  tickRate: 30,
  baseSpeed: 3.9,
  boostSpeed: 7.4,
  turnRate: 0.24,
  pointSpacing: 4,
  startLength: 20,
  minBoostLength: 12,
  worldRadius: WORLD.radius, // single source of truth — never let these drift apart
};

const TICK_RATE = 30;            // simulation steps per second
const BASE_SPEED = 3.9;          // units per tick at normal speed
const BOOST_SPEED = 7.4;         // units per tick while boosting
const TURN_RATE = 0.24;          // max radians the head can turn per tick
const START_LENGTH = 20;         // initial number of trail points
const POINT_SPACING = 4;         // distance between recorded trail points
const SEGMENT_EVERY = 5;         // render a body circle every N trail points
// Food + bot counts are DERIVED from the world area so resizing the arena can never
// silently make it feel empty (sparse food, no snakes in view) again. Tuned against the
// ~1400u view radius in cullFrameFor. Caps guard against pathologically huge worlds.
const WORLD_AREA = Math.PI * WORLD.radius * WORLD.radius;
const FOOD_TARGET = Math.min(6500, Math.round(WORLD_AREA * 1.0e-4)); // lighter field (perf) — still plenty
// Bot count derives from world area, but BOT_TARGET env overrides it (set BOT_TARGET=0 to remove bots).
const BOT_TARGET = process.env.BOT_TARGET != null
  ? Math.max(0, Math.floor(Number(process.env.BOT_TARGET)) || 0)
  : Math.min(40, Math.round(WORLD_AREA * 5.2e-7));               // ~26 @ r=4000 by default
// Chunky +5 orbs: worth seeking out, but kept sparse so they stay a treat (not a carpet).
const ORB_VALUE = 5;
const ORB_TARGET = Math.min(24, Math.round(WORLD_AREA * 3.5e-7));    // ~18   @ r=4000 → a couple in view
const ORB_SPAWN_EVERY = 45;                                         // trickle one in ~every 1.5s until at target
const BOOST_COST_TICKS = 6;      // lose 1 length every this many ticks while boosting
const MIN_BOOST_LENGTH = 12;     // can't boost below this length
const COIL_RADIUS = 130;         // only a TIGHT knit circle (head staying this close to an anchor)…
const COIL_GRACE_TICKS = 150;    // …for this long (~5s @30Hz) counts as coiling/camping
const COIL_DRAIN_EVERY = 6;      // then lose 1 length/score every this many ticks until you move out
const SPAWN_IMMUNITY_MS = 3000;  // brief collision immunity on spawn / respawn / arena reset

let nextId = 1;
// Snake skin palette — also exposed to the client via /api/config so the
// lobby picker offers exactly these (and the server can validate requests).
export const SKINS = [
  '#14F195', '#9945FF', '#00D1FF', '#FF4D6D', '#FFD166',
  '#06FFA5', '#F72585', '#4CC9F0', '#FB8500', '#B5179E',
];
const colors = SKINS;

// Italian Brainrot character skins — themed body colour + an emoji "face" on the head.
export const CHARACTER_SKINS = [
  { name: 'The DUVE', color: '#C98B63', emoji: 'duve', img: '/skins/duve.svg' }, // image skin
  { name: 'Tung Tung Tung Sahur', color: '#9A6B3F', emoji: '🪵' },
  { name: 'Tralalero Tralala', color: '#2E86DE', emoji: '🦈' },
  { name: 'Bombardiro Crocodilo', color: '#4B6F2C', emoji: '🐊' },
  { name: 'Lirilì Larilà', color: '#7FA650', emoji: '🌵' },
  { name: 'Ballerina Cappuccina', color: '#D9A679', emoji: '🩰' },
  { name: 'Chimpanzini Bananini', color: '#F2C14E', emoji: '🍌' },
  { name: 'Brr Brr Patapim', color: '#6B8E5A', emoji: '🌳' },
  { name: 'Boneca Ambalabu', color: '#3FAE5A', emoji: '🐸' },
  { name: 'Trippi Troppi', color: '#FF7AB6', emoji: '🦐' },
  { name: 'Bombombini Gusini', color: '#C0C7CF', emoji: '🪿' },
];
const CHAR_BY_EMOJI = new Map(CHARACTER_SKINS.map((c) => [c.emoji, c]));

// Combined list sent to the client picker: plain colours + characters.
export const ALL_SKINS = [
  ...SKINS.map((c) => ({ color: c })),
  ...CHARACTER_SKINS,
];

// Basic, tasteful profanity mask (case-insensitive). Names are also HTML-escaped client-side.
const PROFANITY = [/fuck/gi, /shit/gi, /cunt/gi, /bitch/gi, /asshole/gi, /\bnigg(er|a)\b/gi, /faggot/gi, /retard/gi];

export function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw);
  // Strip control + zero-width characters, collapse whitespace, clamp length.
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/\s+/g, ' ').trim().slice(0, 16);
  for (const re of PROFANITY) s = s.replace(re, (m) => '*'.repeat(m.length));
  s = s.trim();
  return s.length ? s : 'Anon';
}

function rand(min, max) { return min + Math.random() * (max - min); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
// Squared distance from point (px,py) to the line SEGMENT a→b. Lets collision treat a
// snake's body as a continuous capsule chain instead of isolated dots, so a fast head can
// never thread the gap between two body samples (the old "passing through people" bug).
function segPointDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist2(px, py, ax, ay); // degenerate segment = a point
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t); // clamp the foot of the perpendicular onto the segment
  const cx = ax + t * dx, cy = ay + t * dy;
  return dist2(px, py, cx, cy);
}
function angWrap(a) { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; }
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
    this.playRadius = WORLD.radius; // shrinks during a Death Match; otherwise full
    this.deathMatch = false;        // true while a Death Match is running
  }

  /** Alive non-bot players (used for Death Match win detection). */
  aliveHumans() {
    const out = [];
    for (const p of this.players.values()) if (p.alive && !p.isBot) out.push(p);
    return out;
  }

  spawnFood(x, y, value = 1, color = null, orb = false) {
    if (x === undefined) {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * (WORLD.radius - 30);
      x = Math.cos(a) * r;
      y = Math.sin(a) * r;
    }
    return {
      x, y,
      value,
      color: color || (orb ? '#FFD166' : (Math.random() < 0.12 ? '#9945FF' : '#14F195')),
      r: orb ? 12 : (value > 1 ? 7 : 5),
      orb,
    };
  }

  randomSpawnPoint() {
    // Try several random spots; take the first that's clear of other snakes (≥700u),
    // else the clearest found — so you never spawn on top of someone and instantly die.
    let best = null, bestClear = -1;
    for (let attempt = 0; attempt < 25; attempt++) {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * (WORLD.radius * 0.85);
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      let nearest = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dh = Math.hypot(p.x - x, p.y - y);
        if (dh < nearest) nearest = dh;
        for (let i = 0; i < p.trail.length; i += 12) {
          const s = p.trail[i];
          const d = Math.hypot(s.x - x, s.y - y);
          if (d < nearest) nearest = d;
        }
        if (nearest <= 700) break; // already too close — abandon this candidate
      }
      if (nearest > 700) return { x, y };
      if (nearest > bestClear) { bestClear = nearest; best = { x, y }; }
    }
    return best || { x: 0, y: 0 };
  }

  addPlayer({ name, wallet, isBot = false, socketId = null, color = null, skin = null }) {
    const id = nextId++;
    const { x, y } = this.randomSpawnPoint();
    const angle = rand(0, Math.PI * 2);
    const trail = [];
    for (let i = 0; i < START_LENGTH; i++) {
      trail.push({ x: x - Math.cos(angle) * i * POINT_SPACING, y: y - Math.sin(angle) * i * POINT_SPACING });
    }
    // Resolve skin: a known character emoji themes the body + adds a head face; otherwise
    // honor a palette colour; otherwise a default by id.
    const ch = skin && CHAR_BY_EMOJI.get(skin);
    const bodyColor = ch ? ch.color : ((color && colors.includes(color)) ? color : colors[id % colors.length]);
    const player = {
      id,
      name: sanitizeName(name),
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
      color: bodyColor,
      skin: ch ? ch.emoji : null, // head emoji for character skins
      radius: 12,
      // stats
      kills: 0,
      peakLength: START_LENGTH,
      spawnAt: Date.now(),
      immuneUntil: Date.now() + SPAWN_IMMUNITY_MS, // can't die for a moment after spawning
      // anti-coil: penalize staying in a tiny area (coiling/camping) too long
      coilAnchor: { x, y },
      coilTicks: 0,
      coiling: false,
      // bot ai memory
      _wander: angle,
      _aggro: Math.random(), // 0..1 — only >0.5 bots actively hunt (keeps bots beatable)
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

    // Trickle in chunky +5 orbs toward a small cap — steady appearance, never a flood.
    if (this.tick % ORB_SPAWN_EVERY === 0) {
      let orbs = 0;
      for (const f of this.food) if (f.orb) orbs++;
      if (orbs < ORB_TARGET) this.food.push(this.spawnFood(undefined, undefined, ORB_VALUE, null, true));
    }

    // Mark the current top 3 (by score) so movePlayer can slow them down a touch.
    {
      let a = null, b = null, c = null; // top-3 players by score, descending
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (!a || p.score > a.score) { c = b; b = a; a = p; }
        else if (!b || p.score > b.score) { c = b; b = p; }
        else if (!c || p.score > c.score) { c = p; }
      }
      this._top3 = new Set([a, b, c].filter(Boolean).map((p) => p.id));
    }

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.isBot) this.botThink(p);
      this.movePlayer(p);
    }

    this.handleFood();
    this.handleCoiling();
    this.handleCollisions();
  }

  // Anti-coil: if a snake's head loiters within COIL_RADIUS of an anchor past the
  // grace period (coiling in a tight ball / camping), bleed its length + score until
  // it moves out. Floors at START_LENGTH so it shrinks the camp advantage without killing.
  handleCoiling() {
    const r2 = COIL_RADIUS * COIL_RADIUS;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (dist2(p.x, p.y, p.coilAnchor.x, p.coilAnchor.y) > r2) {
        // Made real progress — reset the anchor and timer.
        p.coilAnchor.x = p.x;
        p.coilAnchor.y = p.y;
        p.coilTicks = 0;
        p.coiling = false;
      } else {
        p.coilTicks++;
        p.coiling = p.coilTicks > COIL_GRACE_TICKS;
        if (p.coiling && p.length > START_LENGTH && this.tick % COIL_DRAIN_EVERY === 0) {
          // Tight-coiling bleeds length/score straight into the void — no droppable food,
          // so you can't farm your own coil. The mass is just gone.
          p.length -= 1;
          p.score = Math.max(0, p.score - 1);
        }
      }
    }
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
        p.score = Math.max(0, p.score - 1); // boosting burns leaderboard points too
        // Drop a glowing pellet behind you as you burn length — collectible by anyone.
        const tail = p.trail[p.trail.length - 1];
        if (tail) {
          const drop = this.spawnFood(tail.x, tail.y, 1, p.color);
          drop.r = 6; // a touch larger so the boost trail reads clearly
          this.food.push(drop);
        }
      }
    } else {
      p.boosting = false;
    }

    // Top-3 catch-up: the current leaders move a little slower, scaled by their size,
    // so the pack can close in and nobody runs away with the round just by being huge.
    if (this._top3 && this._top3.has(p.id)) {
      const penalty = Math.min(0.18, Math.max(0, (p.length - 50) / 450) * 0.18);
      speed *= (1 - penalty);
    }

    const nx = p.x + Math.cos(p.angle) * speed;
    const ny = p.y + Math.sin(p.angle) * speed;
    // Lethal boundary = the current play radius (shrinks during a Death Match; full otherwise).
    if (Math.hypot(nx, ny) > this.playRadius) {
      this.kill(p, 'wall');
      return;
    }
    p.x = nx;
    p.y = ny;

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
    // Spatial hash grid broad-phase: bucket every snake's body as a chain of SEGMENTS
    // (consecutive trail-point pairs), then test each head's distance to the segments in
    // its own + adjacent cells. Treating the body as continuous segments — not isolated
    // dots — means a fast/boosting head can't slip through the gap between two samples
    // (that gap grew to ~37u at boost speed and was the "passing through people" bug).
    // CELL must exceed maxHitDist (≈58) + maxSegLen (≈23) so a 3×3 query is complete.
    const CELL = 150;
    const STEP = 3;  // trail points per collision segment — dense enough that segments chain solid
    const SKIP = 3;  // skip the few points right behind the head (head bulge / head-on grace)
    const now = Date.now();
    const alive = [...this.players.values()].filter((p) => p.alive);

    const grid = new Map(); // "cx,cy" -> [{ ax, ay, bx, by, owner, r }]
    for (const o of alive) {
      if (now < (o.immuneUntil || 0)) continue; // immune snakes' bodies are intangible
      const oR = this.bodyRadius(o);
      const t = o.trail;
      for (let i = SKIP; i + STEP < t.length; i += STEP) {
        const a = t[i], b = t[i + STEP];
        const seg = { ax: a.x, ay: a.y, bx: b.x, by: b.y, owner: o.id, r: oR };
        // Bucket by the segment's first point; segments are short (≤~23u) so a head within
        // hit range always lands in this cell or an adjacent one (covered by the 3×3 query).
        const k = Math.floor(a.x / CELL) + ',' + Math.floor(a.y / CELL);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(seg);
      }
    }

    for (const p of alive) {
      if (now < (p.immuneUntil || 0)) continue; // immune snakes can't die
      const headR = this.bodyRadius(p);
      const cx = Math.floor(p.x / CELL);
      const cy = Math.floor(p.y / CELL);
      let dead = false;
      for (let gx = cx - 1; gx <= cx + 1 && !dead; gx++) {
        for (let gy = cy - 1; gy <= cy + 1 && !dead; gy++) {
          const arr = grid.get(gx + ',' + gy);
          if (!arr) continue;
          for (const s of arr) {
            if (s.owner === p.id) continue; // no self-collision
            const hitDist = headR + s.r;
            if (segPointDist2(p.x, p.y, s.ax, s.ay, s.bx, s.by) <= hitDist * hitDist) {
              this.kill(p, 'collision', this.players.get(s.owner));
              dead = true;
              break;
            }
          }
        }
      }
    }
  }

  kill(p, cause, killer = null) {
    if (!p.alive) return;
    p.alive = false;
    // Scatter the corpse into loot worth about HALF the victim's mass — so eating a kill
    // nets the killer roughly half the size the victim was, never more (stops runaway
    // snowballing off big kills). Total drop value is split into chunky pellets along the body.
    const totalDrop = Math.round(p.length * 0.5);
    if (totalDrop > 0) {
      // Cap each loot pellet at +4 (mostly 4s, a few 3s) so corpse drops stay distinct
      // from the +5 gold orbs. Enough pellets to carry the full half-mass total.
      const pellets = Math.max(1, Math.min(150, Math.ceil(totalDrop / 4)));
      const base = Math.floor(totalDrop / pellets);
      let extra = totalDrop - base * pellets;
      const stride = Math.max(1, Math.floor(p.trail.length / pellets));
      for (let n = 0; n < pellets; n++) {
        const val = base + (extra > 0 ? (extra--, 1) : 0);
        if (val <= 0) continue;
        const s = p.trail[Math.min(p.trail.length - 1, n * stride)] || { x: p.x, y: p.y };
        const drop = this.spawnFood(s.x + rand(-10, 10), s.y + rand(-10, 10), val, p.color);
        drop.r = 6 + Math.min(7, val);
        this.food.push(drop);
      }
    }
    if (killer) {
      killer.score += Math.floor(p.score * 0.5);
      killer.kills += 1;
      // Multi-kill streak: chain kills within 4s bump the streak; otherwise it resets.
      const now = Date.now();
      killer.killStreak = (now - (killer.lastKillAt || 0) <= 4000) ? (killer.killStreak || 0) + 1 : 1;
      killer.lastKillAt = now;
    }

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

  // Full arena wipe (called every few rounds): clear the food field, drop all bots
  // (re-spawned fresh by the next tick), and reset every live human snake back to a
  // clean start — score 0, start length, new position. A total fresh competition.
  resetArena() {
    // Fresh food field (also clears all +5 orbs).
    this.food = [];
    for (let i = 0; i < FOOD_TARGET; i++) this.food.push(this.spawnFood());

    // Drop every bot; step()'s top-up repopulates BOT_TARGET fresh ones next tick.
    for (const p of [...this.players.values()]) if (p.isBot) this.players.delete(p.id);

    // Reset each ALIVE human snake in place — no death screen, just a clean slate.
    // Dead/spectating players are left dead so they STAY in spectate (e.g. an AFK
    // streamer) instead of being force-revived into play.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const { x, y } = this.randomSpawnPoint();
      const angle = rand(0, Math.PI * 2);
      const trail = [];
      for (let i = 0; i < START_LENGTH; i++) {
        trail.push({ x: x - Math.cos(angle) * i * POINT_SPACING, y: y - Math.sin(angle) * i * POINT_SPACING });
      }
      p.x = x; p.y = y; p.angle = angle; p.targetAngle = angle;
      p.trail = trail;
      p.length = START_LENGTH;
      p.score = 0;
      p.peakLength = START_LENGTH;
      p.boosting = false;
      p.alive = true;
      p.spawnAt = Date.now();
      p.immuneUntil = Date.now() + SPAWN_IMMUNITY_MS; // grace right after the wipe
      p.coilAnchor = { x, y };
      p.coilTicks = 0;
      p.coiling = false;
    }
  }

  botThink(p) {
    // Average-skill filler: forages with some purpose, takes the odd boost, avoids the
    // wall and obvious head-on bodies — but doesn't hunt, dodges imperfectly, and plateaus
    // at a moderate size (BOT_SOFT_CAP) so it never dominates the board or takes rewards.
    const BOT_SOFT_CAP = 140;

    // 1) Don't faceplant the lethal ring (adapts to the shrinking Death Match radius).
    if (Math.hypot(p.x, p.y) > this.playRadius * 0.8) {
      p.targetAngle = Math.atan2(-p.y, -p.x) + rand(-0.25, 0.25);
      p._wander = p.targetAngle;
      p.boosting = false;
      return;
    }

    // 2) Light obstacle sense — veer if another snake's body is right ahead. Cheap and
    //    imperfect (average reflexes, not perfect dodging), checked a few times a second.
    if (this.tick % 4 === 0) {
      const hx = p.x + Math.cos(p.angle) * 90, hy = p.y + Math.sin(p.angle) * 90;
      for (const o of this.players.values()) {
        if (o.id === p.id || !o.alive) continue;
        if (Math.abs(o.x - p.x) > 260 || Math.abs(o.y - p.y) > 260) continue;
        for (let i = 6; i < o.trail.length; i += 14) {
          const s = o.trail[i];
          if (dist2(hx, hy, s.x, s.y) < 60 * 60) {
            p.targetAngle = p.angle + (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.5);
            p._wander = p.targetAngle;
            p.boosting = false;
            return;
          }
        }
      }
    }

    // 3) Past the soft cap → stop grinding, just cruise so it plateaus mid-pack.
    if (p.length > BOT_SOFT_CAP) {
      if (this.tick % 20 === 0 || Math.random() < 0.03) p._wander += rand(-0.5, 0.5);
      p.targetAngle = p._wander;
      p.boosting = false;
      return;
    }

    // 4) Forage: steer toward the best nearby food (value-weighted, prefer +5 orbs).
    if (this.tick % 8 === 0) {
      let best = null, bestScore = -Infinity;
      const SIGHT2 = 560 * 560;
      for (const f of this.food) {
        const d = dist2(p.x, p.y, f.x, f.y);
        if (d > SIGHT2) continue;
        const score = (f.orb ? 4 : f.value) * 1e6 - d; // worth-it & nearer = better
        if (score > bestScore) { bestScore = score; best = f; }
      }
      if (best) {
        p._wander = Math.atan2(best.y - p.y, best.x - p.x);
        // Occasionally sprint for a worthwhile, slightly-far morsel — average, not sweaty.
        p.boosting = p.length > MIN_BOOST_LENGTH
          && dist2(p.x, p.y, best.x, best.y) > 240 * 240 && Math.random() < 0.18;
      } else {
        p.boosting = false;
      }
    }

    // 5) Meander between decisions.
    if (this.tick % 16 === 0 || Math.random() < 0.03) p._wander += rand(-0.5, 0.5);
    p.targetAngle = p._wander;
  }

  botName() {
    // Realistic player-style handles — deliberately NOT obvious bots (no "bot"/"snek" tells).
    // Picks one not already in use so the filler crowd never shows duplicate names.
    const pool = [
      'mooncat', 'jpegjay', 'soldegen', '0xmilo', 'baggz', 'wenlambo', 'frogprince', 'gwei',
      'lowcapgem', 'sendit', 'apexx', 'rugsurvivor', 'hodlr', 'tetsuo', 'kaito', 'nullbyte',
      'sol_sniper', 'dingaling', 'beanstalk', 'vinto', 'zksam', 'maxbid', 'degenjoe', 'liqd',
      'fomofred', 'satoshilite', 'chadwick', 'orbiter', 'greenwojak', 'bonkboy', 'snipez',
      'wagmiwill', 'lasercat', 'solstice', 'dexter', 'probly_nothing', 'anonymoose', 'jeffrey',
      'tendies', 'gigabrain', 'pumpkin', 'voidwalker', 'mistr_e', 'koda', 'rin', 'blkswan',
    ];
    for (let i = 0; i < 10; i++) {
      const n = pool[Math.floor(Math.random() * pool.length)];
      let taken = false;
      for (const p of this.players.values()) if (p.name === n) { taken = true; break; }
      if (!taken) return n;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Build a snapshot to send to a particular player (culled to their view).
  // Build the per-tick render frame ONCE (shared across all viewers): each snake's
  // wire object is built a single time, and food is bucketed into a grid for cheap culling.
  // This replaces the old O(viewers × snakes × segments) per-player snapshot with
  // O(snakes × segments) once + O(viewers × nearby) culling — the key to scaling players.
  buildFrame() {
    const snakes = [];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
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
        immune: Date.now() < (p.immuneUntil || 0),
        segs,
        ...(p.skin ? { sk: p.skin } : {}),
      });
    }

    const FCELL = 700;
    const foodGrid = new Map();
    for (const f of this.food) {
      const k = Math.floor(f.x / FCELL) + ',' + Math.floor(f.y / FCELL);
      let arr = foodGrid.get(k);
      if (!arr) foodGrid.set(k, (arr = []));
      arr.push(f);
    }
    return { snakes, foodGrid, fcell: FCELL };
  }

  // Cheap per-viewer cull: filter the shared frame around (cx, cy). Reuses snake
  // wire objects (no rebuild) and only scans food cells overlapping the viewport.
  cullFrameFor(frame, cx, cy) {
    const view = 1400;                 // snakes: wider so they don't pop in at the edge
    const cullR2 = (view + 600) * (view + 600);
    const foodView = 1050;             // food only needs to cover the screen — much lighter payload
    const foodView2 = foodView * foodView;

    const snakes = [];
    for (const s of frame.snakes) {
      const dx = s.x - cx, dy = s.y - cy;
      if (dx * dx + dy * dy <= cullR2) snakes.push(s);
    }

    const food = [];
    const C = frame.fcell;
    const minx = Math.floor((cx - foodView) / C), maxx = Math.floor((cx + foodView) / C);
    const miny = Math.floor((cy - foodView) / C), maxy = Math.floor((cy + foodView) / C);
    for (let gx = minx; gx <= maxx; gx++) {
      for (let gy = miny; gy <= maxy; gy++) {
        const arr = frame.foodGrid.get(gx + ',' + gy);
        if (!arr) continue;
        for (const f of arr) {
          const dx = f.x - cx, dy = f.y - cy;
          if (dx * dx + dy * dy <= foodView2) food.push([Math.round(f.x), Math.round(f.y), f.r, f.color]);
        }
      }
    }
    return { snakes, food, world: { radius: Math.round(this.playRadius) } };
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
      // NOTE: deliberately do NOT expose isBot — filler bots should be indistinguishable
      // from real players on the wire (no bot tag anywhere on the client).
      .map((p) => ({ id: p.id, name: p.name, score: p.score, wallet: p.wallet }));
  }

  get tickRate() { return TICK_RATE; }
}
