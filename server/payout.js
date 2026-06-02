import { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { config } from './config.js';

// ─────────────────────────────────────────────────────────────
// PAYOUT — sends each round's creator-fee rewards to the top-5 wallets.
//
// ⚠️  This moves REAL SOL. It is DISABLED by default and only runs when you
//     explicitly opt in with env vars on your server (never commit the key):
//        PAYOUT_ENABLED=1
//        TREASURY_SECRET_KEY=[12,34,...]   ← 64-byte secret key as a JSON array
//                                            (e.g. contents of a solana-keygen json)
//
// Flow each round end (called from RoundManager.payoutHook):
//   winners = [{ rank, name, wallet, score, sol }]  (top 5; sol already split 30/20/15/10/10)
//   → transfer `sol` SOL from your treasury hot-wallet to each winner's wallet.
//
// TODO (your ATM-coin mechanics): before splitting, set the round pool = the
//   creator fees actually collected this period, instead of the fixed
//   config.rewardPoolSol placeholder. Then 85% is split here and you keep 15%.
//   Hook your fee-claim step in `claimFees()` below (runs a few seconds before payout).
// ─────────────────────────────────────────────────────────────

const ENABLED = process.env.PAYOUT_ENABLED === '1';

let treasury = null;
let connection = null;

function parseSecretKey(raw) {
  raw = (raw || '').trim();
  if (!raw) throw new Error('TREASURY_SECRET_KEY not set');
  if (raw.startsWith('[')) return Uint8Array.from(JSON.parse(raw)); // JSON byte array (keygen file)
  throw new Error('TREASURY_SECRET_KEY must be a 64-byte JSON array (add bs58 if you prefer base58)');
}

if (ENABLED) {
  try {
    treasury = Keypair.fromSecretKey(parseSecretKey(process.env.TREASURY_SECRET_KEY));
    connection = new Connection(config.rpcUrl, 'confirmed');
    console.log(`[payout] ENABLED — treasury ${treasury.publicKey.toBase58()}`);
  } catch (e) {
    console.error('[payout] stays OFF (record-only):', e.message);
    treasury = null;
  }
} else {
  console.log('[payout] record-only (set PAYOUT_ENABLED=1 + TREASURY_SECRET_KEY to send real SOL).');
}

/** Optional: claim/collect creator fees a few seconds before distributing. Wire your ATM logic here. */
export async function claimFees() {
  // e.g. call your fee-collection program / sweep, then return the collected SOL amount.
  return null;
}

/** Called by RoundManager.payoutHook(winners, round). Sends SOL to each winner when enabled. */
export async function payoutWinners(winners, round) {
  if (!treasury || !connection) return; // record-only by default — no on-chain action
  for (const w of winners) {
    if (!w.wallet || !(w.sol > 0)) continue;
    try {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: new PublicKey(w.wallet),
        lamports: Math.round(w.sol * LAMPORTS_PER_SOL),
      }));
      const sig = await connection.sendTransaction(tx, [treasury]);
      console.log(`[payout] round ${round} → ${w.name} ${w.sol} SOL  sig=${sig}`);
    } catch (e) {
      console.error(`[payout] FAILED round ${round} → ${w.wallet}:`, e.message);
    }
  }
}

export const payoutEnabled = () => !!treasury;
