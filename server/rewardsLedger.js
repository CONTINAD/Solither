import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────
// Rewards ledger: cumulative SOL attributed to each winning wallet
// across all rounds, plus a grand total. Persisted to
// data/rewards-ledger.json. Shown on the lobby ("rewards sent" + top earners).
// The actual on-chain transfer is settled by the operator's payout bot;
// this ledger is the source of truth for what each wallet has earned.
// ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'rewards-ledger.json');

let ledger = { totalSol: 0, rounds: 0, byWallet: {} };

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (d && typeof d.totalSol === 'number' && d.byWallet) ledger = d;
  } catch {
    /* fresh ledger */
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.error('[ledger] save failed:', e.message);
  }
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** entries: [{ wallet, name, sol }] — accrue per-wallet SOL + the global total. */
export function recordPayout(entries) {
  let any = false;
  for (const e of entries) {
    if (!e || !e.wallet || !(e.sol > 0)) continue;
    any = true;
    const w = ledger.byWallet[e.wallet] || (ledger.byWallet[e.wallet] = { name: e.name, sol: 0, wins: 0 });
    if (e.name) w.name = e.name;
    w.sol = round4(w.sol + e.sol);
    w.wins += 1;
    ledger.totalSol = round4(ledger.totalSol + e.sol);
  }
  if (any) { ledger.rounds += 1; save(); }
}

export function rewardsSummary(n = 10) {
  const top = Object.entries(ledger.byWallet)
    .map(([wallet, v]) => ({ wallet, name: v.name, sol: v.sol, wins: v.wins }))
    .sort((a, b) => b.sol - a.sol)
    .slice(0, n);
  return { totalSol: ledger.totalSol, rounds: ledger.rounds, top };
}

load();
