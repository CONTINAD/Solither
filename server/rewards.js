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
    this.payoutHook = null; // optional: async (winners, round) => void
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
    if (Date.now() >= this.roundEndsAt) this.endRound();
  }

  endRound() {
    // Only humans (with wallets) are eligible for creator rewards.
    const ranked = [...this.game.players.values()]
      .filter((p) => p.alive && !p.isBot && p.wallet)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topN);

    // Each rank gets a FIXED % of the gross pool (30/20/15/10/10). The unused
    // 15% (+ any unfilled ranks) is the creator's cut — not distributed.
    const pool = config.rewardPoolSol;

    const winners = ranked.map((p, i) => ({
      rank: i + 1,
      name: p.name,
      wallet: p.wallet,
      score: p.score,
      sol: Math.round((pool * (REWARD_WEIGHTS[i] || 0)) * 1e4) / 1e4,
    }));

    const record = {
      round: this.roundNumber,
      endedAt: new Date().toISOString(),
      winners,
    };
    this.history.push(record);
    if (this.history.length > 50) this.history.shift();

    // Accrue the per-wallet + total SOL ledger (shown in the lobby).
    if (winners.length) recordPayout(winners);

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

    // Optional automated payout integration point.
    if (this.payoutHook && winners.length) {
      Promise.resolve(this.payoutHook(winners, this.roundNumber)).catch((e) =>
        console.error('[rewards] payout hook failed:', e.message)
      );
    }

    // Every 3rd round: full arena wipe — fresh food, fresh bots, every snake reset.
    if (this.roundNumber % 3 === 0) {
      this.game.resetArena();
      this.io.emit('arenaReset', { afterRound: this.roundNumber });
      console.log(`[Solither] Arena wiped after round ${this.roundNumber} — fresh start.`);
    }

    // Start the next round.
    this.roundNumber += 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this._save(); // persist new round number + history so a redeploy resumes, not resets
    this.io.emit('roundStarted', this.status());
  }
}
