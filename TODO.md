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
- [x] Boost mass-drop verified: each boost tick burns 1 length + drops a booster-colored r=6 pellet at the tail, collectible by anyone (headless-tested: 7 burns→7 drops near tail, eater grows)

## Audio
- [x] Web Audio SFX: synthesized eat/boost-hum/death/round-win, HUD mute button (🔊/🔇) persisted to localStorage; audio inits on first play gesture

## UI / juice
- [x] Round-win overlay: non-blocking "Round N Champions" podium (🥇🥈🥉) + 150-particle confetti burst, auto-hides after 5.5s
- [x] Animated starfield/nebula: 2 parallax star layers (twinkle) + 3 drifting nebula gradient blobs behind the world
- [x] Connection status dot (green/red w/ pulse) in HUD + "reconnecting" toast + socket.io auto-reconnect that re-joins with stored name/wallet on 'connect'
- [x] Skin picker in lobby: 10 swatches from server palette, saved to localStorage, sent on join; server validates color against SKINS (verified orange snake)
- [ ] Show your shortened wallet + length in HUD
- [ ] Off-screen leaderboard arrow pointing to your rank when not in top 10

## Persistence / meta
- [ ] Session high-score board persisted to data/highscores.json (name+score)
- [ ] Lobby panel: last 5 rounds' winners (from /api/rounds)

## Hardening
- [ ] Server-side input rate limiting + name length/profanity sanitize
- [ ] Pause/dim render when tab hidden; resume cleanly
- [ ] Favicon + polished <title>/OG meta tags

## Stretch
- [ ] Spatial hash grid for collision broad-phase (scale to many players)
- [ ] Settings panel: toggle sound, minimap, particles
