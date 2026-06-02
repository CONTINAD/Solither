# 🐍 Solither — Sol + Slither

A real-time multiplayer [slither.io](https://slither.io)-style arena game, **gated by a Solana token**.
Paste your wallet + a name, and as long as that wallet holds the required amount of the game's
SPL token you're in. Every **3 minutes** a reward round ends and the **top 3 players** are recorded
as creator-reward winners.

```
Sol  +  Slither   →   Solither
```

## Features

- ⚡ **Server-authoritative** real-time slither game (Node + Socket.IO, 30 Hz sim).
- 🔒 **Token gate** — verifies the pasted wallet holds ≥ 500,000 of your SPL token via Solana RPC.
- 🏆 **3-minute reward rounds** — top 3 human players each round are snapshotted with their wallets.
- 🤖 **Bots** keep the arena lively when player count is low.
- 🗺️ Minimap, live leaderboard, round timer, boost, death/respawn, mobile touch controls.
- 🎨 Solana-themed neon UI (green/purple).

## Quick start

```bash
npm install
cp .env.example .env       # (Windows: copy .env.example .env)
npm start
```

Then open **http://localhost:3000**.

> With no `TOKEN_MINT` set, the game runs in **DEMO MODE** — anyone can join with any valid
> wallet address (no on-chain balance is checked). This lets you play immediately.

## Going live with your token

Edit `.env`:

```ini
TOKEN_MINT=YourSplTokenMintAddressHere
MIN_TOKEN_BALANCE=500000
SOLANA_RPC_URL=https://your-helius-or-quicknode-endpoint
ROUND_SECONDS=180
REWARD_TOP_N=3
```

Restart the server. Now only wallets holding ≥ `MIN_TOKEN_BALANCE` of `TOKEN_MINT` can play.
The public mainnet RPC is rate-limited — use [Helius](https://helius.dev) or
[QuickNode](https://quicknode.com) for any real traffic.

## How rewards work

This server **records** the winning wallets each round (printed to the console, emitted to clients,
and available at `GET /api/rounds`). It does **not** automatically send funds — moving real tokens
requires a funded treasury keypair and is a financial action you should control.

To wire up automated payouts, set `rounds.payoutHook` in `server/index.js`:

```js
rounds.payoutHook = async (winners, roundNumber) => {
  // winners = [{ rank, name, wallet, score }]
  // Use @solana/web3.js + a treasury Keypair to transfer your reward split here.
};
```

A safe rollout: run it in record-only mode first, watch `GET /api/rounds`, and settle payouts
manually until you trust the standings.

## Project layout

```
server/
  index.js     Express + Socket.IO server, sim loop, broadcast loop
  game.js      Slither engine: snakes, food, bots, collisions, snapshots
  solana.js    Wallet token-balance verification (cached)
  rewards.js   3-minute round manager + winner recording
  config.js    Env-driven config + demo-mode detection
public/
  index.html   Lobby, HUD, death screen
  client.js    Canvas renderer, input, networking
  style.css    Neon Solana theme
```

## Controls

| Action | Input |
|--------|-------|
| Steer  | Move mouse / drag finger |
| Boost  | Hold click / Space / touch (burns length) |
| Goal   | Eat orbs to grow; ram rivals into your body to kill them |

---

*Not financial advice. The token gate reads balances only — it never has custody of funds.*
