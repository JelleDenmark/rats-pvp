# Rats PvP — design notes

Living notes for the PvP fork of We Ride at Dawn. Core loop: async board-vs-board
**ghost** duels — build a board, it auto-fights a stored snapshot of another
player. See `packages/core/src/duel.ts` (`simulateDuel`).

## Format v1 (prototype)

- **Equalized economy.** Every player gets a flat **100 scrap** to assemble a
  board — no season-long accrual, so no veteran-gap and no snowball (the reason
  we diverge from WRAD's economy; a persistent bank is unfair in PvP).
- **Rounds.** Every **2 hours**, every submitted board fights **every other**
  board (all-vs-all round robin).
- **Scoring.** Football-style match points — **win 3, draw 1, loss 0** — summed
  across all opponents. The **survivor differential** (your survivors − theirs)
  is a separate "goal difference" **tiebreak**, so the standings reward winning
  without a few decisive stomps running away with the round. (Started as a raw
  +1/−1 survivor margin; softened to points after the round-sim showed it was
  too swingy — trivially tunable in `run-round.ts`.)
- Prototype simulator: `npm run round-sim`.

## Combat model

- A duel is **one symmetric wave**: board A vs board B, same engine as PvE
  (`simulateCore` in `sim.ts`, `duel` mode). Front clash is simultaneous ⇒ the
  matchup is seat-symmetric — `simulateDuel(x, x)` draws (invariant test in
  `test/duel.test.ts`).
- Deterministic in `(a, b)` ⇒ client and server can re-simulate and agree
  (anti-cheat).

## The counter triangle (relic-free, innate)

`npm run win-matrix` — every board 1-1, **0 draws, 0 seating-sensitive**:

```
WALL  >  THORN  >  BRUISER  >  WALL
```

Six PvP units (`data/units.ts`, flagged `pvpOnly` so the PvE shop never sees
them), cost 16 each (a 6-rat board = 96 ≤ 100):

| Unit | Role | Stats | Innate mechanic |
|------|------|-------|-----------------|
| Plate-Rat | WALL | 3/7 | armor (damageReduction 3) |
| Bramble-Rat | THORN | 1/9 | reflect 4 on being hit |
| Gorge-Rat | BRUISER | 4/6 | lifesteal (heal 3 after each attack) |
| Dire-Rat | WALL | 3/9 | armor (damageReduction 2) |
| Steel-Whisker | THORN | 3/7 | armor 1 + reflect 3 on being hit |
| Grave-Leech | BRUISER | 6/5 | lifesteal (heal 2 after each attack) |

- **Wall > Thorn** — armor floors the thorn's tiny attack to nothing.
- **Thorn > Bruiser** — reflect outpaces the bruiser's lifesteal.
- **Bruiser > Wall** — the bruiser out-sustains the wall's armor-floored chip.

### Issue #1 — 1 -> 2 per role, imported from WRAD directly

Rather than design new mechanics, the second unit per role is a **direct
import of an existing WRAD PvE kit that already matches the role**: Dire-Rat
(armor), Steel-Whisker (armor + reflect), and Grave-Leech (lifesteal) all
already exist in `UNIT_DEFS` for the gauntlet — only their PvP stat lines and
`pvpOnly` flag are new (`dire-rat-pvp` / `steel-whisker-pvp` /
`grave-leech-pvp` ids, since the PvE originals stay in the shop pool at their
own PvE cost/stats). Each import is tuned to be a genuine **in-role
alternative**, not a strict upgrade or downgrade of the original pick:

- **Dire-Rat** trades a point of armor for two more health than Plate-Rat — a
  softer wall that outlasts chip damage instead of stonewalling it.
- **Steel-Whisker** is Bramble-Rat's reflect plus a point of armor, at lower
  reflect damage — tankier but milder.
- **Grave-Leech** is a glass-cannon lifesteal build: more attack, less health
  and a smaller per-hit drain than Gorge-Rat.

Verified with `npm run win-matrix` (fixture extended to all 6 boards, per the
issue's instruction to extend the fixture as units are added): the alt trio
reproduces the same `WALL > THORN > BRUISER > WALL` cycle
(`BRUISER > WALL-2 > THORN-2 > BRUISER` — the identical directed cycle,
rotated), and every one of the 6 boards has at least one decisive win in the
full round-robin — no role/pick is a dead choice. Per the issue's explicit
guardrail, no attempt was made to flatten the matrix to 100% balance beyond
that bar.

### How we got here (the balance findings)

1. **Pure stats can't make rock-paper-scissors.** A numeric search over all
   (attack, health) profiles found NO balanced non-transitive cycle — RPS
   *requires* a conditional mechanic.
2. **Cleave/execute pierce works but breaks fairness.** An innate cleave brawler
   made a cycle, but `cleaveOverkill`'s overkill spill resolves side-A-first, so
   a mirror (AGGRO vs AGGRO) had side A win — disqualifying for a fair ladder.
   The mirror-fairness test catches exactly this.
3. **Armor + reflect + lifesteal are all seat-safe** and form a clean cycle. So
   the v1 triangle uses only those.

The engine gained two optional innate combat traits for this (`cleaveOverkill`,
`executeThreshold` on `UnitDef`) mirroring the Gore-Cleaver / Marrow-Snap
relics; they're unused by WRAD units, so PvE stays byte-identical.

## Single-wave format findings

- **Poison-all is degenerate** (Draughtsman-Moe / Blight-Witch) — an armor- and
  position-ignoring AoE that beats everything in one wave. Excluded.
- **Once-per-wave abilities are weak** in a one-wave duel (summon-swarm,
  backline snipers fire a single volley). A real *swarm* or *sniper* role wants
  PvP-tuned numbers or a multi-wave format.

## Relics

Deliberately **out of v1** — for cleaner unit balancing and to keep the counter
structure in innate kits. The relic *plumbing* still exists in the engine; relics
just aren't part of the PvP economy. Reintroduce later as a deliberate second
axis once the base roster is a stable RPS.

## Deferred ideas — NOT for now, noted for later

### Richer positional combat
The single-front-clash model is thin. Two candidates:
- **Two rows** — front/back rows; attacks hit the first or second row.
- **Hearthstone-Battlegrounds targeting** — fixed attack order, random target,
  overruled by **Taunt** (must be hit first) and **Stealth** (untargetable until
  revealed).

Either changes the targeting core in `sim.ts`, so post-v1. Gotcha: random
targeting needs a **seeded per-duel RNG** (hash both device ids + round) so
client/server still reproduce byte-identical results for anti-cheat — the engine
already ships a seeded xorshift128 (`prng.ts`).

### Multi-wave / multi-round duels
Would revive the summon-swarm and poison archetypes (their engines assume
repeated waves) and further smooth any seat variance. "Best-of-N with board
refresh" is the natural candidate.

### Tribe / type-advantage layer
The `tribe` field is dormant and could later become a Pokémon-style multiplier;
keep the duel damage step factored so it can slot in without an engine rewrite.
