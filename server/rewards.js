import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { recordPayout } from './rewardsLedger.js';

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
      lastWinners: this.history.length ? this.history[this.history.length - 1].winners : [],
    };
  }

  tick() {
    const now = Date.now();
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

    // Every 3rd round: full arena wipe — fresh food, fresh bots, every snake reset.
    if (this.roundNumber % 3 === 0) {
      this.game.resetArena();
      this.io.emit('arenaReset', { afterRound: this.roundNumber });
      console.log(`[Solither] Arena wiped after round ${this.roundNumber} — fresh start.`);
    }

    // Start the next round — reset the per-round claim state.
    this._claimStarted = false;
    this._claimPromise = null;
    this.roundNumber += 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this._save(); // persist new round number + history so a redeploy resumes, not resets
    this.io.emit('roundStarted', this.status());
  }
}
