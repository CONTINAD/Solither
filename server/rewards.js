import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { recordPayout } from './rewardsLedger.js';
import { WORLD } from './game.js';

// Round history + counter persist to data/rounds.json so the "recent rounds" list and
// the round number survive restarts/redeploys (when DATA_DIR points at a persistent volume).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ROUNDS_FILE = path.join(DATA_DIR, 'rounds.json');

// Fixed SOL split by rank (top 5): 35/25/15/10/5% of the pool = 90% to players.
// NOT normalized — the remaining 10% (and any unfilled ranks) is the creator's cut.
const REWARD_WEIGHTS = [0.35, 0.25, 0.15, 0.10, 0.05];

// Claim creator fees this many ms before the round ends, so the SOL has landed
// in the treasury by the time we compute + send payouts.
const CLAIM_LEAD_MS = Number(process.env.CLAIM_LEAD_MS) || 10000;

// ── Death Match (battle royale) ──────────────────────────────
// Fires on every :00/:30 wall-clock slot (at the next round boundary). The play circle
// shrinks, there's no respawn, last snake standing takes the whole pool. Then normal resumes.
const DM_INTERVAL_MS  = (Number(process.env.DM_INTERVAL_MIN) || 30) * 60 * 1000;
const DM_COUNTDOWN_MS = Number(process.env.DM_COUNTDOWN_MS) || 10000;  // "get ready" countdown before the match goes live (everyone immune)
const DM_GRACE_MS    = Number(process.env.DM_GRACE_MS)   || 5000;    // after GO, before the circle starts closing
const DM_SHRINK_MS   = Number(process.env.DM_SHRINK_MS)  || 90000;   // time to fully close
const DM_MIN_RADIUS  = Number(process.env.DM_MIN_RADIUS) || 300;     // final ring size
const DM_MAX_MS      = Number(process.env.DM_MAX_MS)     || 210000;  // hard cap (~3.5 min)
const DM_MIN_PLAYERS = Number(process.env.DM_MIN_PLAYERS)|| 2;       // need this many alive to run
const DM_WINNER_PCT  = Number(process.env.DM_WINNER_PCT) || 0.9;     // winner takes this share of claimed fees

// ── Chaos Mode (power-up free-for-all) ───────────────────────
// Fires on every :15/:45 slot (at the next round boundary), alternating with the Death
// Matches at :00/:30. Power-ups spawn everywhere (speed/shield/magnet/multi/phase/ghost),
// no eliminations or payout — pure fun. Resets to a clean arena when it ends so the normal
// reward rounds stay fair. Offset by 15 min so it never collides with a Death Match.
const CHAOS_SLOT_MS = 30 * 60 * 1000;                                // 30-min cadence…
const CHAOS_OFFSET_MS = 15 * 60 * 1000;                              // …shifted to land on :15 / :45
const CHAOS_MS = Number(process.env.CHAOS_MS) || 120000;             // how long Chaos runs (~2 min)

// ─────────────────────────────────────────────────────────────
// Reward rounds: every ROUND_SECONDS, snapshot the top N *human*
// players and record them as that round's reward winners.
//
// Actual on-chain payout is intentionally NOT performed automatically
// (that requires a funded treasury keypair and is a financial action).
// Winners + their wallets are recorded and emitted so an operator /
// payout script / treasury bot can settle. See payoutHook below.
// ─────────────────────────────────────────────────────────────

export class RoundManager {
  constructor(game, io) {
    this.game = game;
    this.io = io;
    this.roundLength = config.roundSeconds * 1000;
    this.topN = config.rewardTopN;
    this.roundNumber = 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this.history = []; // [{ round, endedAt, winners: [...] }]
    this.payoutHook = null;   // async (winners, round) => results — sends SOL to winners
    this.feeClaimHook = null; // async () => SOL netted in — claims pump.fun creator fees
    this._claimStarted = false;
    this._claimPromise = null; // resolves to the SOL claimed this round (= the pool)
    this._ending = false;      // re-entry guard while endRound() awaits the claim
    // Death Match state
    this.dmActive = false;
    this.dmPending = false;
    this.dmStartAt = 0;
    this.dmCountdownUntil = 0; // during the pre-match "get ready" countdown, this is in the future
    this._dmSlot = Math.floor(Date.now() / DM_INTERVAL_MS); // current :00/:30 slot
    this._dmLeaderId = null; // top alive during the DM (winner fallback)
    // Chaos Mode state (fires at :15/:45, alternating with the Death Matches)
    this.chaosActive = false;
    this.chaosPending = false;
    this.chaosUntil = 0;
    this._chaosSlot = Math.floor((Date.now() - CHAOS_OFFSET_MS) / CHAOS_SLOT_MS); // current :15/:45 slot
    this._load(); // resume round number + recent history across restarts
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(ROUNDS_FILE, 'utf8'));
      if (d && Array.isArray(d.history)) this.history = d.history.slice(-50);
      if (d && typeof d.roundNumber === 'number' && d.roundNumber > 0) this.roundNumber = d.roundNumber;
    } catch { /* fresh start — no saved rounds yet */ }
  }

  _save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ROUNDS_FILE, JSON.stringify({ roundNumber: this.roundNumber, history: this.history }, null, 2));
    } catch (e) {
      console.error('[rounds] save failed:', e.message);
    }
  }

  /** Reset round counter + history (used by RESET_STATS on boot). */
  resetRounds() {
    this.roundNumber = 1;
    this.history = [];
    this.roundEndsAt = Date.now() + this.roundLength;
    this._save();
  }

  msRemaining() {
    return Math.max(0, this.roundEndsAt - Date.now());
  }

  status() {
    return {
      round: this.roundNumber,
      msRemaining: this.msRemaining(),
      roundLength: this.roundLength,
      topN: this.topN,
      deathMatch: this.dmActive,
      chaos: this.chaosActive,
      lastWinners: this.history.length ? this.history[this.history.length - 1].winners : [],
    };
  }

  tick() {
    const now = Date.now();

    // A special mode takes over the loop entirely while it runs.
    if (this.dmActive) { this._tickDeathMatch(now); return; }
    if (this.chaosActive) { this._tickChaos(now); return; }

    // Cross a :00/:30 slot boundary → queue a Death Match for the next round boundary.
    const slot = Math.floor(now / DM_INTERVAL_MS);
    if (slot !== this._dmSlot) { this._dmSlot = slot; this.dmPending = true; }

    // Cross a :15/:45 slot boundary → queue Chaos Mode for the next round boundary.
    const cslot = Math.floor((now - CHAOS_OFFSET_MS) / CHAOS_SLOT_MS);
    if (cslot !== this._chaosSlot) { this._chaosSlot = cslot; this.chaosPending = true; }

    const msLeft = this.roundEndsAt - now;
    // ~10s before the end, START the creator-fee claim. Keep the PROMISE so endRound
    // can AWAIT it — its result (SOL netted in) is this round's pool.
    if (!this._claimStarted && this.feeClaimHook && msLeft > 0 && msLeft <= CLAIM_LEAD_MS) {
      this._claimStarted = true;
      this.io.emit('claiming', { round: this.roundNumber }); // client shows "claiming rewards…"
      this._claimPromise = Promise.resolve()
        .then(() => this.feeClaimHook())
        .then((sol) => {
          const s = Number(sol) || 0;
          this.io.emit('claimed', { round: this.roundNumber, sol: s });
          console.log(`[Solither] Round ${this.roundNumber} claim → ${s.toFixed(6)} SOL pool.`);
          return s;
        })
        .catch((e) => { console.error('[rewards] claim failed:', e.message); return 0; });
    }
    // End the round once. endRound is async now — guard against re-entry while it awaits.
    if (now >= this.roundEndsAt && !this._ending) {
      this._ending = true;
      Promise.resolve(this.endRound())
        .catch((e) => console.error('[rewards] endRound failed:', e.message))
        .finally(() => { this._ending = false; });
    }
  }

  async endRound() {
    // The pool = creator fees claimed this round. WAIT for the claim to finish so the
    // SOL is actually in the treasury and payouts use the real amount (0 if none / off).
    let pool = 0;
    try {
      if (this._claimPromise) pool = Number(await this._claimPromise) || 0;
      else if (this.feeClaimHook) pool = Number(await this.feeClaimHook()) || 0;
    } catch { pool = 0; }

    // TEST override: MANUAL_POOL_SOL forces a fixed pool (paid from the treasury's own
    // balance) so the split + send to winners can be verified without real creator fees.
    // Leave it unset/0 in production so the pool = actual claimed fees.
    const manualPool = Number(process.env.MANUAL_POOL_SOL) || 0;
    if (manualPool > 0) pool = manualPool;

    // Only humans (with wallets) are eligible for creator rewards.
    const ranked = [...this.game.players.values()]
      .filter((p) => p.alive && !p.isBot && p.wallet)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topN);

    // Each rank gets a fixed % (35/25/15/10/5); the unused 10% is the creator's cut.
    const winners = ranked.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      wallet: p.wallet,
      score: p.score,
      sol: Math.round((pool * (REWARD_WEIGHTS[i] || 0)) * 1e5) / 1e5,
    }));

    const record = {
      round: this.roundNumber,
      endedAt: new Date().toISOString(),
      pool: Math.round(pool * 1e5) / 1e5,
      winners,
    };
    this.history.push(record);
    if (this.history.length > 50) this.history.shift();

    // Accrue the per-wallet + total SOL ledger only when there's a real pool
    // (real claimed fees being paid out), so the lobby total reflects actual SOL sent.
    if (winners.length && pool > 0) recordPayout(winners);

    if (winners.length) {
      console.log(`\n[Solither] ── Round ${this.roundNumber} complete ──`);
      for (const w of winners) {
        console.log(`  #${w.rank}  ${w.name}  (${w.wallet})  score=${w.score}  +${w.sol} SOL`);
      }
    } else {
      console.log(`[Solither] Round ${this.roundNumber} complete — no eligible players.`);
    }

    // Broadcast a celebratory event to all clients.
    this.io.emit('roundEnded', record);

    // Send the SOL to the winners (only when there's a real pool), then broadcast the
    // result so clients can show "rewards sent" with tx links.
    if (this.payoutHook && winners.length && pool > 0) {
      const r = this.roundNumber;
      Promise.resolve(this.payoutHook(winners, r))
        .then((results) => { if (results && results.length) this.io.emit('payout', { round: r, results }); })
        .catch((e) => console.error('[rewards] payout hook failed:', e.message));
    }

    this._claimStarted = false;
    this._claimPromise = null;

    // A Death Match is queued (we crossed a :00/:30 mark): start it instead of a normal
    // round — but only with enough players, otherwise skip it and carry on.
    if (this.dmPending) {
      this.dmPending = false;
      if (this.game.aliveHumans().length >= DM_MIN_PLAYERS) { this.startDeathMatch(); return; }
      console.log('[Solither] Death Match skipped — not enough players.');
    }

    // Chaos Mode is queued (we crossed a :15/:45 mark): run it instead of a normal round.
    // (DM takes priority above, but they're 15 min apart so they never both pend.)
    if (this.chaosPending) {
      this.chaosPending = false;
      this.startChaos();
      return;
    }

    // Every 3rd round: full arena wipe — fresh food, fresh bots, every snake reset.
    if (this.roundNumber % 3 === 0) {
      this.game.resetArena();
      this.io.emit('arenaReset', { afterRound: this.roundNumber });
      console.log(`[Solither] Arena wiped after round ${this.roundNumber} — fresh start.`);
    }

    // Start the next normal round.
    this.roundNumber += 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this._save(); // persist new round number + history so a redeploy resumes, not resets
    this.io.emit('roundStarted', this.status());
  }

  // ── Death Match ────────────────────────────────────────────
  startDeathMatch() {
    this.dmActive = true;
    const now = Date.now();
    // A "get ready" countdown runs first: arena is set, everyone's immune, ring is full.
    // The match clock (grace → shrink → cap) only starts when the countdown ends ("GO").
    this.dmCountdownUntil = now + DM_COUNTDOWN_MS;
    this.dmStartAt = this.dmCountdownUntil;
    this._dmLeaderId = null;
    this.game.deathMatch = true;
    this.game.playRadius = WORLD.radius;
    this.game.resetArena(); // fresh, fair start — fresh spawn for everyone alive
    // Keep everyone immune through the whole countdown (+1s past GO) so positioning is safe
    // and the reveal isn't an instant-kill scramble.
    const immuneTil = this.dmCountdownUntil + 1000;
    for (const p of this.game.players.values()) if (p.alive) p.immuneUntil = immuneTil;
    this.io.emit('deathMatchStart', { countdownMs: DM_COUNTDOWN_MS, graceMs: DM_GRACE_MS, shrinkMs: DM_SHRINK_MS });
    console.log(`[Solither] ⚔️  DEATH MATCH — ${Math.round(DM_COUNTDOWN_MS / 1000)}s countdown, then last snake standing wins the pot.`);
  }

  _tickDeathMatch(now) {
    // "Get ready" countdown: hold the full ring, nobody's out yet, no win checks.
    if (now < this.dmCountdownUntil) {
      this.game.playRadius = WORLD.radius;
      return;
    }
    const elapsed = now - this.dmStartAt; // 0 at "GO"
    const W = WORLD.radius;
    // Hold full size during the grace, then close the ring down to the minimum.
    if (elapsed <= DM_GRACE_MS) {
      this.game.playRadius = W;
    } else {
      const t = Math.min(1, (elapsed - DM_GRACE_MS) / DM_SHRINK_MS);
      this.game.playRadius = W - (W - DM_MIN_RADIUS) * t;
    }
    // Track the current leader (winner fallback) + check the win condition.
    const alive = this.game.aliveHumans();
    if (alive.length) {
      let top = alive[0];
      for (const p of alive) if (p.score > top.score) top = p;
      this._dmLeaderId = top.id;
    }
    if ((alive.length <= 1 || elapsed > DM_MAX_MS) && !this._ending) {
      this._ending = true;
      Promise.resolve(this.endDeathMatch())
        .catch((e) => console.error('[rewards] endDeathMatch failed:', e.message))
        .finally(() => { this._ending = false; });
    }
  }

  async endDeathMatch() {
    const alive = this.game.aliveHumans();
    const winner = alive[0] || this.game.players.get(this._dmLeaderId) || this.game.topAliveSnake() || null;

    // Claim the period's creator fees → the WHOLE player-pool goes to the one winner.
    let pool = 0;
    try { if (this.feeClaimHook) pool = Number(await this.feeClaimHook()) || 0; } catch (e) { console.error('[rewards] DM claim:', e.message); }
    const sol = Math.round(pool * DM_WINNER_PCT * 1e5) / 1e5;

    let results = [];
    if (winner && winner.wallet && sol > 0) {
      const w = [{ rank: 1, name: winner.name, wallet: winner.wallet, score: winner.score, sol }];
      recordPayout(w);
      if (this.payoutHook) { try { results = await this.payoutHook(w, 'DM') || []; } catch (e) { console.error('[rewards] DM payout:', e.message); } }
    }
    this.io.emit('deathMatchEnd', {
      winner: winner ? { name: winner.name, score: winner.score } : null,
      sol, results,
    });
    console.log(`[Solither] ⚔️  DEATH MATCH won by ${winner ? winner.name : '—'} → +${sol} SOL.`);

    // Back to the regular game.
    this.game.deathMatch = false;
    this.game.playRadius = WORLD.radius;
    this.dmActive = false;
    this._claimStarted = false;
    this._claimPromise = null;
    this.game.resetArena();
    this.roundNumber += 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this._save();
    this.io.emit('roundStarted', this.status());
  }

  // ── Chaos Mode ─────────────────────────────────────────────
  startChaos() {
    this.chaosActive = true;
    this.chaosUntil = Date.now() + CHAOS_MS;
    this.game.chaosMode = true;       // step() starts trickling power-ups in
    this.game.powerups = [];          // fresh field of pickups
    // No arena reset and no payout — players keep their snakes and just grab power-ups.
    this.io.emit('chaosStart', { durationMs: CHAOS_MS });
    console.log(`[Solither] 🌀  CHAOS MODE — power-ups everywhere for ${Math.round(CHAOS_MS / 1000)}s.`);
  }

  _tickChaos(now) {
    if (now >= this.chaosUntil && !this._ending) {
      this._ending = true;
      try { this.endChaos(); } finally { this._ending = false; }
    }
  }

  endChaos() {
    this.game.chaosMode = false;
    this.game.clearChaos();           // drop pickups + clear everyone's active effects
    this.chaosActive = false;
    this.io.emit('chaosEnd', {});
    console.log('[Solither] 🌀  CHAOS MODE over — back to the regular game.');

    // Fresh, fair start for the normal reward rounds (so Chaos gains don't carry over).
    this._claimStarted = false;
    this._claimPromise = null;
    this.game.resetArena();
    this.roundNumber += 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this._save();
    this.io.emit('roundStarted', this.status());
  }
}
