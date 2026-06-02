# Solither backlog (Ralph loop)

The loop works top-to-bottom: pick the first unchecked item, build it fully, verify it
in the running preview (no console errors; screenshot if visual), then check it off with a
one-line note. When all are checked, append new high-value ideas and keep going.

## Done
- [x] Core multiplayer slither engine (snakes, food, bots, collisions)
- [x] Solana token gate (500k) + demo mode
- [x] 5-minute reward rounds, top-3 winners recorded
- [x] Client prediction + interpolation + cheap renderer (~180fps)
- [x] Boost: gate fix + flame particles + head aura + mobile boost button

## Gameplay feel
- [x] Eat feedback: floating "+N" pop + white head flash on eating (detects server length-up)
- [x] Kill feed (top-left): server broadcasts 'kill' events; client shows "You ate {x}"/"{a} ate {b}", fades after 4s
- [x] Death screen stats: server tracks peak length/kills/survival/rank, shown in a 2x2 grid on the death card
- [x] Spectate mode: death-screen "Spectate leader" → server re-centers snapshot on live #1 snake, camera follows it, "Spectating {name}" bar with Respawn. (user-requested) ✓ verified following BonkMoon
- [x] Better bot AI: priority-based (wall > avoid nearby bodies > hunt smaller heads w/ lead+boost > seek food > wander)
- [x] Mobile leaderboard: cap to top 6 on phones (width<=560) so it doesn't cover the top-right; full 10 on desktop. Off-list rank row uses the same limit so 7th+ still shows. (user-requested, iOS)
- [x] Mobile controls fix: steering (drag anywhere) no longer triggers boost — boost is the dedicated button ONLY, so touch players stop wasting mass/score on boost (verified via synthetic touch). Steering finger tracked by touch id. (user-requested)
- [x] Boost now burns leaderboard SCORE too (not just length), floored at 0 — wasting mass on boost costs you rank (user-requested)
- [x] Boost mass-drop verified: each boost tick burns 1 length + drops a booster-colored r=6 pellet at the tail, collectible by anyone (headless-tested: 7 burns→7 drops near tail, eater grows)

## Anti-grief (user-requested)
- [x] Anti-coil: if a snake's head stays within 230u of an anchor for >~5s (coiling in a ball / camping), it bleeds 1 length+score every 6 ticks until it moves out; floors at START_LENGTH (won't kill). Client shows a throttled "stop coiling" toast. Verified headlessly (coiler drains, floor holds, mover exempt).

## Rewards (user-requested)
- [x] Reward split reworked: TOP 5 winners get fixed % of the pool — 1st 30% / 2nd 20% / 3rd 15% / 4th 10% / 5th 10% (=85% to players); creator keeps the remaining 15% (no normalization). REWARD_TOP_N=5. Tagline/leaderboard-note/banner all read "top 5" dynamically. Verified split headlessly (0.075/0.05/0.0375/0.025/0.025 of 0.25; creator 0.0375). NOTE: actual on-chain claim-a-few-seconds-before + distribute-to-holders is the payout bot's job (payoutHook).

## Rewards ledger (user-requested)
- [x] Lobby shows "💰 Rewards sent to players" total SOL + "Top earners (SOL)" board. server/rewardsLedger.js persists per-wallet SOL + grand total to data/rewards-ledger.json; each round splits config.rewardPoolSol (ROUND_REWARD_SOL, default 0.25) among top 3 by 50/30/20; /api/rewards serves it. Verified: split math + accrual (headless) and lobby banner/board (UI).

## Audio
- [x] Web Audio SFX: synthesized eat/boost-hum/death/round-win, HUD mute button (🔊/🔇) persisted to localStorage; audio inits on first play gesture

## UI / juice
- [x] Round-win overlay: non-blocking "Round N Champions" podium (🥇🥈🥉) + 150-particle confetti burst, auto-hides after 5.5s
- [x] Animated starfield/nebula: 2 parallax star layers (twinkle) + 3 drifting nebula gradient blobs behind the world
- [x] Connection status dot (green/red w/ pulse) in HUD + "reconnecting" toast + socket.io auto-reconnect that re-joins with stored name/wallet on 'connect'
- [x] Skin picker in lobby: 10 swatches from server palette, saved to localStorage, sent on join; server validates color against SKINS (verified orange snake)
- [x] Player HUD badge (bottom-left): snake-color dot + name + shortened wallet (So11…1112) + live length
- [x] Off-list rank row: when you're outside the top 10, the leaderboard shows a "▾ {rank} {name} {score}" row (server sends live rank); verified at rank 15 with 14 bots

## Persistence / meta
- [x] All-time high-score board: server/highscores.js persists top 10 to data/highscores.json on death; /api/highscores serves it; lobby shows it (verified record→persist→render)
- [x] Lobby "Recent round winners" panel: shows last 5 rounds (each with its top-3 podium) from /api/rounds, scrollable

## Hardening
- [x] Hardening: per-socket input cap (~60/s) + join/respawn/spectate cooldowns; sanitizeName() strips control/zero-width chars, collapses whitespace, clamps 16, masks profanity (headless-tested, used in addPlayer)
- [x] Tab-visibility handling: rAF auto-pauses when hidden (saves CPU); on resume, reset frame clock (no dt spike), clear stale interpolation buffer, and drop stuck boost (verified hide/show cycle)
- [x] Favicon (branded snake-S SVG) + polished <title> + full OG/Twitter/theme-color meta tags + 1200x630 og.svg (verified served + decoded; PNG OG flagged as follow-up for crawlers that reject SVG)

## Round 3 ideas
- [x] Round-win overlay podium now shows each champion's SOL reward (0.075/0.05/… SOL) instead of score — ties the payout into the celebration. Verified all 5 rows render SOL.
- [x] Multi-kill streak juice: kills within 4s chain a streak (server tracks killStreak); ≥2 fires a "DOUBLE/TRIPLE/QUAD/PENTA KILL!" banner + rising sound to the killer. Verified streak math (1→2→reset) + banner render.
- [ ] AFK kick: disconnect players who send no input for ~60s (frees slots toward the cap)

## Stretch
- [x] Spatial hash grid collision broad-phase (CELL=120, 3×3 query): O(snakes×segments) → ~O(total-segments) for many-player scaling. Headless-tested (head-on-body kills+credits, no self-collision, far-apart safe); runs clean in-game.
- [x] Settings panel (⚙ in HUD): toggle Sound / Minimap / Particles, persisted to localStorage. Minimap toggle hides wrapper + skips draw; particles toggle gates boost fx/eat pops/confetti. (verified toggles + persistence)

## Round 2 ideas (backlog cleared — fresh high-value items)
- [x] Max-player cap (MAX_PLAYERS, default 50): join rejected over capacity with "Arena is full (N players)" (verified reject at 0 + normal join at 50)
- [x] Round-end urgency cue: red edge vignette in last 10s (rAF opacity pulse — not a CSS anim, so it never blocks screenshots) + countdown tick sound in last 5s. Verified toggle ≤10s / off >10s, no errors.
- [x] Spectate upgrade: "Next ▶" button + ←/→ keys cycle through the leaderboard; server tracks each spectator's targetId and re-centers on it (falls back to leader if target dies). Verified cycling SolPump→ApePump→WagmiKing.
