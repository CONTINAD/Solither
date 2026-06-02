import { Connection, PublicKey } from '@solana/web3.js';
import { config, DEMO_MODE } from './config.js';

const connection = DEMO_MODE ? null : new Connection(config.rpcUrl, 'confirmed');

// Cache of { wallet -> { ok, balance, expires } } to avoid hammering the RPC.
const cache = new Map();

function isValidPublicKey(str) {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a wallet holds at least the required token balance.
 * Returns { ok: boolean, balance: number, reason?: string }.
 */
export async function verifyWallet(wallet) {
  wallet = (wallet || '').trim();

  if (!isValidPublicKey(wallet)) {
    return { ok: false, balance: 0, reason: 'That is not a valid Solana wallet address.' };
  }

  // Demo mode: skip the on-chain check entirely.
  if (DEMO_MODE) {
    return { ok: true, balance: config.minTokenBalance, reason: 'demo' };
  }

  // Serve from cache when fresh.
  const cached = cache.get(wallet);
  const now = Date.now();
  if (cached && cached.expires > now) {
    return { ok: cached.ok, balance: cached.balance, reason: cached.ok ? undefined : cached.reason };
  }

  try {
    const owner = new PublicKey(wallet);
    const mint = new PublicKey(config.tokenMint);

    const resp = await connection.getParsedTokenAccountsByOwner(owner, { mint });

    let balance = 0;
    for (const { account } of resp.value) {
      const amt = account.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof amt === 'number') balance += amt;
    }

    const ok = balance >= config.minTokenBalance;
    const result = {
      ok,
      balance,
      reason: ok
        ? undefined
        : `Wallet holds ${balance.toLocaleString()} tokens — need ${config.minTokenBalance.toLocaleString()} to play.`,
    };

    cache.set(wallet, {
      ...result,
      expires: now + config.balanceCacheSeconds * 1000,
    });

    return result;
  } catch (err) {
    console.error('[solana] balance check failed:', err.message);
    return { ok: false, balance: 0, reason: 'Could not reach Solana RPC to verify your balance. Try again.' };
  }
}

/** Drop a wallet from cache (e.g. forced re-check). */
export function invalidateWallet(wallet) {
  cache.delete((wallet || '').trim());
}
