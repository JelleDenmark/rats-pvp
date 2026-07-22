# Rats PvP — design notes

Living notes for the PvP fork of We Ride at Dawn. The core loop is async
board-vs-board **ghost** duels: build a board, it auto-fights a stored snapshot
of another player at a scheduled tick. See `packages/core/src/duel.ts`
(`simulateDuel`) and the plan in the session history for the full architecture.

## Current combat model (v1)

- A duel is **one symmetric wave**: side A's board vs side B's board, fought to
  the death through the same engine as PvE (`simulateCore` in `sim.ts`, `duel`
  mode). Front clash is simultaneous, so the matchup is seat-symmetric —
  `simulateDuel(x, x)` draws (invariant test in `test/duel.test.ts`).
- Deterministic in `(a, b)`: client and server can re-simulate and agree
  (anti-cheat).

## First-pass counter triangle (emergent, from inherent roles)

Verified by `npm run win-matrix` — every board 1-1, 0 seating-sensitive:

```
AGGRO  >  REFLECT-TANK  >  SNIPER  >  AGGRO
```

- **Sniper > Aggro** — Slink-Rat's `backlineDamage` bypasses reflect and picks
  the aggro bruisers apart.
- **Reflect-Tank > Sniper** — big HP pools soak the sniper's flat chip.
- **Aggro > Reflect-Tank** — raw attack + Gore-Cleaver overkill punches through
  faster than Steel-Whisker's reflect can punish.

8 units: dire-rat, corpse-glutton, gnawer, press-kin, steel-whisker,
warren-warden, md-rattyfock, slink-rat (+ rusted-nail, gore-cleaver relics).
**Not finely balanced** — the cycle closes, but win margins are untuned and it
leans on relics + a deliberately low-armor "reflect tank". Fine-tuning units for
PvP is expected and fine.

## Format findings (single-wave duels)

1. **Poison-all is degenerate.** Draughtsman-Moe / Blight-Witch apply an armor-
   AND position-ignoring AoE that beats everything in one wave. Excluded from
   the v1 subset. A poison archetype needs a PvP-specific nerf or a multi-wave
   format before it fits.
2. **The WRAD summon-swarm is toothless in one wave.** Rat-Piper / Brood-Mother
   are balanced for a 45-wave ride where summons refresh every wave; fired once,
   they do nothing. "Aggro" fills that slot for now. A real *swarm* role wants
   either PvP-tuned stats or a multi-round format.

## Deferred ideas — NOT for now, noted for later

### More combat dimensionality (positional targeting)
The current single-front-clash model is thin. Two candidate richer models:

- **Two rows.** Units occupy a front and back row; attacks hit the first OR
  second row (e.g. randomly, or by rule). Adds real positioning decisions and a
  natural home for a genuine "backline sniper" and "protect the carry".
- **Hearthstone Battlegrounds style.** Attack *order* is fixed (or alternating),
  but each attack's *target* is chosen at random from the enemy board — with
  overrides: **Taunt**-type units must be hit first, **Stealth**-type units
  can't be targeted until revealed. This introduces variance + protection roles
  and makes board positioning and keyword coverage matter.

Either of these would change the sim's targeting core (currently strictly
front-vs-front in `sim.ts`), so they're post-v1. Note the tension with
determinism: HS-BG-style random targeting needs a **seeded** RNG per duel
(hash the two device ids + round) so client/server still reproduce byte-identical
results for anti-cheat — the engine already ships a seeded xorshift128 (`prng.ts`)
for exactly this.

### Multi-wave / multi-round duels
Would revive the summon-swarm and poison archetypes (their engines assume
repeated waves) and neutralize the rare seat-sensitivity seen on real boards
(Test #1). A "best-of-N rounds with board refresh" format is the natural
candidate.

### Tribe / type advantage & tactic banners
Explicitly deferred by design. The `tribe` field (`units.ts`) is dormant and
could later become a Pokémon-style multiplier; keep the duel damage step factored
so a per-tribe multiplier can slot in without an engine rewrite.
