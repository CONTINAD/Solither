import dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';
dotenv.config();

// A mint only counts if it's a real Solana address — so a blank/placeholder/typo
// TOKEN_MINT safely stays in demo mode instead of locking everyone out.
function isValidMint(m) {
  if (!m) return false;
  try { new PublicKey(m); return true; } catch { return false; }
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),

  // Token gating
  tokenMint: (process.env.TOKEN_MINT || '').trim(),
  minTokenBalance: num(process.env.MIN_TOKEN_BALANCE, 250000),
  rpcUrl: (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim(),
  balanceCacheSeconds: num(process.env.BALANCE_CACHE_SECONDS, 30),

  // Max concurrent human players (protects performance). Excess joins get "arena full".
  // Reshaped for 150: larger world (effective area-of-interest culling) + 18Hz broadcast.
  maxPlayers: num(process.env.MAX_PLAYERS, 150),

  // Rounds
  roundSeconds: num(process.env.ROUND_SECONDS, 180),
  rewardTopN: num(process.env.REWARD_TOP_N, 5),

  // Gross SOL pool per round. Distributed to the top 5 by fixed % (30/20/15/10/10 = 85%);
  // the remaining 15% is the creator's cut (not distributed). Drives the lobby ledger;
  // your payout bot does the actual claim + distribute to holders.
  rewardPoolSol: num(process.env.ROUND_REWARD_SOL, 0.25),
};

// Auto-detect: only a VALID mint activates the gate. Anything else → demo (CA hidden,
// no gate), so setting TOKEN_MINT to a real address is all it takes to flip everything on.
if (!isValidMint(config.tokenMint)) config.tokenMint = '';
export const DEMO_MODE = config.tokenMint.length === 0;

if (DEMO_MODE) {
  console.warn(
    '\x1b[33m[Solither] DEMO MODE: no TOKEN_MINT set — anyone can join without holding tokens.\x1b[0m'
  );
} else {
  console.log(
    `[Solither] Token gate active: holders of >= ${config.minTokenBalance.toLocaleString()} of ${config.tokenMint} may play.`
  );
}
