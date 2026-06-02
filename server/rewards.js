import { config } from './config.js';
import { recordPayout } from './rewardsLedger.js';

// Fixed SOL split by rank (top 5): 30/20/15/10/10% of the pool = 85% to players.
// NOT normalized — the remaining 15% (and any unfilled ranks) is the creator's cut.
const REWARD_WEIGHTS = [0.30, 0.20, 0.15, 0.10, 0.10];

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

    // Start the next round.
    this.roundNumber += 1;
    this.roundEndsAt = Date.now() + this.roundLength;
    this.io.emit('roundStarted', this.status());
  }
}
