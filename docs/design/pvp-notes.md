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
  too swingy — trivially tunable via `scoreRound` in `packages/core/src/pvp.ts`.)
- Prototype simulator: `npm run round-sim`.

## Milestone A — automated rounds + board legality (2026-07-23)

Rounds now run themselves and a forged board can't be scored:

- **Round lifecycle.** `pvp_rounds` (`supabase/migrations/2026-07-23-add-pvp-rounds.sql`)
  tracks `opens_at`/`closes_at`/`status` (`open` → `scoring` → `closed`) per
  round id. `submit_pvp_board` now rejects a submission unless the round is
  `open` and `closes_at` hasn't passed — a server-authoritative cutoff, not the
  client's clock.
- **Board legality.** `validateBoard`/`legalEntrants` in `packages/core/src/pvp.ts`
  is the single source of truth for "is this a legal PvP board" (right budget,
  right cap, only `pvpOnly` units, tier 1, no relics) — used by BOTH the client
  builder (friendly pre-submit feedback) and the round runner (authoritative:
  illegal boards are dropped from the round-robin entirely, so a raw POST to
  the RPC forging a tier-99 or over-budget board simply can't be scored).
- **Automation.** `packages/core/scripts/advance-round.ts` closes any round
  past `closes_at` (scoring + writing `pvp_results` via the shared
  `scoreRound`) and opens the next one, run on a schedule by
  `.github/workflows/rats-cron.yml` (every 2h). `run-round.ts`/`reset-round.ts`
  and the `rats-control.yml` phone panel remain as the manual operator
  override — same underlying `runAndWriteRound` logic.
- **One shared scorer.** `scoreRound` (core) is now the only implementation of
  the round-robin + football-points scoring; the live runner, the cron
  entry point, and the offline `round-sim.ts` prototype all call it, so they
  can't drift apart.

## Milestone B2 — two-row parallel lanes, opt-in (2026-07-23)

Positional combat, revised from the original "HS-BG random targeting vs two
rows" sketch after closer engine research found: combat has zero RNG anywhere
(`xorshift128` is pre-battle content generation only), and there's a proven
bug class for exactly the risk random targeting would add — `cleaveOverkill`'s
overkill spillover resolved side-A-first with no mirrored check, so a mirror
match with it on both sides didn't draw (found live, unpatched, during this
research — fixed as part of this work). Two-row lanes sidesteps that risk
entirely: no RNG, no Taunt/Stealth, fully deterministic.

- **Design.** Front `ceil(n/2)` units of the submitted board = lane 1, rest =
  lane 2 (purely positional, no schema/UI change). Both lanes clash
  simultaneously each tick instead of one clash per tick. Opt-in via
  `{ twoLane: true }` on `simulateDuel`/`BattleMode`'s `duel` variant, default
  off — every existing call site and the live round format are unaffected
  until an explicit later decision flips it.
- **A real bug fixed along the way.** `cleaveOverkill`'s spillover now checks
  both directions (previously only the horde's front unit was ever
  consulted). Provably inert for all real content today — no shipped unit or
  enemy sets `cleaveOverkill`, enemies never carry relics, PvP boards can't
  carry relics at all — so this only matters the day a future unit equips it
  on both sides of a match.
- **A new edge case: cross-lane "stranding."** If lane 1 decides one way and
  lane 2 decides the other, both sides can end up with an unopposed survivor
  and no shared lane left — resolved by the health/attack tiebreak instead of
  a real fight (lanes deliberately never "reach across"). Measured via
  `npm run win-matrix -- --two-lane`:
  - **Mono-stack boards** (the existing WALL/THORN/BRUISER/PRESS fixtures):
    **0% stranding** — a mono-stack's two lanes are identical units, so they
    always decide the same way. The counter-triangle matrix (cycles, standings,
    0 seat-splits) comes out byte-identical to single-lane for these boards.
  - **Mixed-composition boards** (half one role, half another — closer to a
    real player's build): **33% of duels (10/30)** resolved via the tiebreak
    rather than a wipe. Non-transitivity and seat-fairness still held (0
    splits, 6 counter cycles found), but a third of mixed matchups not
    resolving as a real fight is a real gameplay-feel concern for the live
    format, not just a correctness footnote.
- **Not live.** The round-robin (`scoreRound`, `run-round.ts`/`advance-round.ts`)
  and the client's replay re-simulation all still call `simulateDuel` with no
  options — untouched, byte-identical. Flipping the live format to two-lane
  (deciding what to do about stranding, if anything) is an explicit, separate
  decision, not bundled into shipping the capability.
- Tests: `packages/core/test/two-lane.test.ts` (mirror-fairness across even/odd
  board sizes, lane-assignment/clash-pairing, no-reach-across, the stranding
  edge case, the symmetric-cleave fix, determinism, default-off equivalence).
- Analysis: `npm run win-matrix -- --two-lane` (mono-stack matrix + a
  supplementary mixed-composition pass).

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
| Press-Kin | *(4th)* | 2/6 | buffAdjacent +2/+2 at startOfBattle |

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

Verified with `npm run win-matrix` (fixture extended to all boards, per the
issue's instruction to extend the fixture as units are added): the alt trio
reproduces the same `WALL > THORN > BRUISER > WALL` cycle
(`BRUISER > WALL-2 > THORN-2 > BRUISER` — the identical directed cycle,
rotated), and every board has at least one decisive win in the full
round-robin — no role/pick is a dead choice. Per the issue's explicit
guardrail, no attempt was made to flatten the matrix to 100% balance beyond
that bar.

### Press-Kin — a deliberate 4th archetype (outside the triangle)

Press-Kin is imported from WRAD as a **fourth pick that does NOT sit in the
armor/reflect/lifesteal triangle**. It has no counter mechanic — just a
symmetric, fire-once `buffAdjacent +2/+2` (`startOfBattle`), so it's
mirror-safe (the duel mirror test auto-covers it). Its identity is a
**raw-beef stat-stick with a clean built-in counter**: a mono-stack (4W/2L)
beats both walls and both bruisers, but folds decisively to **reflect** — its
buffed attackers just feed the thorns' return damage — so a thorn board is
always its hard answer. That keeps the meta self-correcting (press rises →
thorn rises → press falls) rather than letting a stat pick run away. Health
was tuned 5 → 6 (7 made it the single dominant board). A single copy is a
build-around that pumps its two neighbours.

**Why not plague-bearer / brood-mother** (both proposed, both rejected after
an empirical `win-matrix` pass): plague-bearer's `poisonLastEnemy` poisons the
enemy's *back* rat — the one not in the single-wave clash — so a mono-stack
went **0W/8L**, a hard dead pick. brood-mother's faint-summon underdelivers in
one wave (the notes' known single-wave summon limitation), landing weak at
2W/4L with no counter identity. Both would need a real rework (not a drop-in
import) to earn a seat, so they're left out for now.

## Placeholder art (issue #2)

The `pvpOnly` roster has no dedicated art yet. `packages/app/src/art.ts` maps
each PvP `defId` to an existing WRAD SVG portrait via a `PVP_ART_ALIASES` table
(aliases, not file copies, so placeholders track their source). The two units
imported wholesale from WRAD reuse their own art; the rest borrow a
role-appropriate asset:

| PvP unit | Placeholder art | Fit |
|----------|-----------------|-----|
| Plate-Rat | `culvert-knight` | full plate armor |
| Bramble-Rat | `grate-golem` | sharp iron grate |
| Gorge-Rat | `corpse-glutton` | bloated glutton |
| Dire-Rat | `dire-rat` | own art (imported unit) |
| Steel-Whisker | `sluice-bulwark` | riveted steel armor |
| Grave-Leech | `dray-ogre` | hulking brute |
| Press-Kin | `press-kin` | own art (imported unit) |

Replace with dedicated PvP art when commissioned.

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

### Richer positional combat — status: capability shipped, not live (see Milestone B2 above)
Two-row parallel lanes is built and opt-in (`{ twoLane: true }`); the live
round format still hasn't been flipped over pending a decision on the
cross-lane stranding tradeoff. HS-BG-style random targeting (fixed attack
order, random target, Taunt/Stealth) was reconsidered and NOT pursued — combat
has never consumed an RNG stream, and the proven `cleaveOverkill`
side-A-first bug (see Milestone B2) is exactly the risk class random
targeting would add on top of. Not ruled out forever, just a materially
higher-risk lift than two-row lanes turned out to be.

### Multi-wave / multi-round duels — status: shelved, not pursued
The engine is 100% deterministic — repeating the same `simulateDuel(a,b)`
call N times with unchanged boards produces byte-identical results every
time, so a naive "best-of-N" is a no-op, not a real format. Making it
meaningful would need either an undesigned "comeback after a wipe" rule or
introducing net-new RNG into combat. Revisit only if a concrete,
well-specified format shows up — "their engines assume repeated waves" turned
out to need more design than a one-line note could resolve.

### Tribe / type-advantage layer
The `tribe` field is dormant and could later become a Pokémon-style multiplier;
keep the duel damage step factored so it can slot in without an engine rewrite.
