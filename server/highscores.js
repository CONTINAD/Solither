import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ─────────────────────────────────────────────────────────────
// All-time high-score board, persisted to data/highscores.json.
// Survives restarts locally. (On ephemeral hosts it resets on redeploy.)
// ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'highscores.json');
const MAX = 10;

let scores = [];

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) scores = arr.filter((s) => s && typeof s.score === 'number').slice(0, MAX);
  } catch {
    scores = [];
  }
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(scores, null, 2));
  } catch (e) {
    console.error('[highscores] save failed:', e.message);
  }
}

/** Record a finished run; returns true if it made the board. */
export function recordScore(name, score, wallet) {
  score = Math.floor(score || 0);
  if (score <= 0) return false;
  scores.push({
    name: (name || 'Anon').slice(0, 16),
    score,
    wallet: wallet || null,
    at: new Date().toISOString(),
  });
  scores.sort((a, b) => b.score - a.score);
  const wasInserted = scores.findIndex((s) => s.score === score) < MAX;
  scores = scores.slice(0, MAX);
  save();
  return wasInserted;
}

export function topScores(n = MAX) {
  return scores.slice(0, n);
}

load();
