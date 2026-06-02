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
- [ ] Better bot AI: steer away from nearby snake bodies, chase smaller heads
- [ ] Boost mass-drop is visible & collectible (verify pellets spawn behind booster)

## Audio
- [ ] Web Audio SFX: eat, boost loop, death, round-win. Mute toggle in HUD + remember in localStorage

## UI / juice
- [ ] Round-win overlay: winner banner + confetti burst for the top 3
- [ ] Animated starfield / nebula parallax background
- [ ] Connection status dot (green/red) + auto-reconnect + "reconnecting" toast
- [ ] Skin picker in lobby (choose snake color, remembered in localStorage)
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
