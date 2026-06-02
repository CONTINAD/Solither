import dotenv from 'dotenv';
dotenv.config();

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),

  // Token gating
  tokenMint: (process.env.TOKEN_MINT || '').trim(),
  minTokenBalance: num(process.env.MIN_TOKEN_BALANCE, 500000),
  rpcUrl: (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim(),
  balanceCacheSeconds: num(process.env.BALANCE_CACHE_SECONDS, 120),

  // Max concurrent human players (protects performance). Excess joins get "arena full".
  // Load-tested on the current Railway instance: ~75 holds full 22Hz, 100 strains (18Hz),
  // 150 gets choppy (~8.6Hz). 80 = smooth headroom. Raise via MAX_PLAYERS env if you upsize the box.
  maxPlayers: num(process.env.MAX_PLAYERS, 80),

  // Rounds
  roundSeconds: num(process.env.ROUND_SECONDS, 180),
  rewardTopN: num(process.env.REWARD_TOP_N, 5),

  // Gross SOL pool per round. Distributed to the top 5 by fixed % (30/20/15/10/10 = 85%);
  // the remaining 15% is the creator's cut (not distributed). Drives the lobby ledger;
  // your payout bot does the actual claim + distribute to holders.
  rewardPoolSol: num(process.env.ROUND_REWARD_SOL, 0.25),
};

// Demo mode = no real token configured, so the wallet gate is bypassed.
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
