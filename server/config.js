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
  maxPlayers: num(process.env.MAX_PLAYERS, 50),

  // Rounds
  roundSeconds: num(process.env.ROUND_SECONDS, 180),
  rewardTopN: num(process.env.REWARD_TOP_N, 3),

  // SOL reward pool distributed among the top players each round (split 50/30/20).
  // This drives the rewards ledger shown in the lobby; your payout bot settles it.
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
