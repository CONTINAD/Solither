import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  VersionedTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

// ─────────────────────────────────────────────────────────────
// PAYOUT — claims pump.fun creator fees, then sends them to the round winners.
//
// ⚠️  Moves REAL SOL. DISABLED unless you opt in on the server:
//        PAYOUT_ENABLED=1
//        TREASURY_SECRET_KEY=<base58 secret key  OR  [12,34,...] byte array>
//        (the wallet that CREATED the coin — it both claims fees and pays winners)
//
// Each round (RoundManager drives the timing):
//   ~10s before the round ends → claimFees() pulls pump.fun creator fees into the
//   treasury via PumpPortal's collectCreatorFee (built remotely, signed LOCALLY here).
//   The SOL that actually landed becomes that round's pool — so payouts are exactly
//   the fees earned that period, never a placeholder, never your principal.
//   At round end → payoutWinners() transfers each winner their split.
// ─────────────────────────────────────────────────────────────

const ENABLED = process.env.PAYOUT_ENABLED === '1';
const PRIORITY_FEE = Number(process.env.PAYOUT_PRIORITY_FEE) || 0.00005;

let treasury = null;
let connection = null;

function parseSecretKey(raw) {
  raw = (raw || '').trim();
  if (!raw) throw new Error('TREASURY_SECRET_KEY not set');
  if (raw.startsWith('[')) return Uint8Array.from(JSON.parse(raw)); // JSON byte array
  return bs58.decode(raw);                                          // base58 (phantom export, etc.)
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

/**
 * Claim pump.fun creator fees into the treasury wallet.
 * Returns the SOL that actually netted in this claim (0 if none / disabled / failed).
 */
export async function claimFees() {
  if (!treasury || !connection) return 0;
  try {
    const before = await connection.getBalance(treasury.publicKey);

    const resp = await fetch('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: treasury.publicKey.toBase58(),
        action: 'collectCreatorFee',
        priorityFee: PRIORITY_FEE,
        pool: 'pump',
      }),
    });
    if (resp.status !== 200) {
      console.error('[claim] PumpPortal error', resp.status, await resp.text().catch(() => ''));
      return 0;
    }

    const tx = VersionedTransaction.deserialize(new Uint8Array(await resp.arrayBuffer()));
    tx.sign([treasury]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
    await connection.confirmTransaction(sig, 'confirmed');

    const after = await connection.getBalance(treasury.publicKey);
    const netSol = Math.max(0, (after - before) / LAMPORTS_PER_SOL);
    console.log(`[claim] netted ~${netSol.toFixed(6)} SOL  https://solscan.io/tx/${sig}`);
    return netSol;
  } catch (e) {
    console.error('[claim] failed:', e.message);
    return 0;
  }
}

/**
 * Send each winner their SOL from the treasury.
 * Returns [{ wallet, name, sol, sig?|error? }] for the UI / logs.
 */
export async function payoutWinners(winners, round) {
  if (!treasury || !connection) return [];
  const results = [];
  for (const w of winners) {
    if (!w.wallet || !(w.sol > 0)) continue;
    try {
      const tx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: new PublicKey(w.wallet),
        lamports: Math.round(w.sol * LAMPORTS_PER_SOL),
      }));
      const sig = await connection.sendTransaction(tx, [treasury]);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log(`[payout] round ${round} → ${w.name} ${w.sol} SOL  https://solscan.io/tx/${sig}`);
      results.push({ wallet: w.wallet, name: w.name, sol: w.sol, sig });
    } catch (e) {
      console.error(`[payout] FAILED round ${round} → ${w.wallet}:`, e.message);
      results.push({ wallet: w.wallet, name: w.name, sol: w.sol, error: e.message });
    }
  }
  return results;
}

export const payoutEnabled = () => !!treasury;
