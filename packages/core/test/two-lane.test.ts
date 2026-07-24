import { describe, expect, it } from 'vitest';
import { simulateDuel } from '../src/duel';
import { UNIT_DEFS, type Lineup } from '../src/data/units';
import type { BattleEvent } from '../src/sim';

const L = (...units: Lineup['units']): Lineup => ({ units });
const ROSTER = Object.keys(UNIT_DEFS).filter((id) => id !== 'pup');
const ofType = <T extends BattleEvent['type']>(events: BattleEvent[], type: T) =>
  events.filter((e): e is Extract<BattleEvent, { type: T }> => e.type === type);

// Milestone B2: two-row parallel lanes. Lane assignment is purely positional
// (front ceil(n/2) units = lane 1, rest = lane 2), opt-in via
// `{ twoLane: true }`, default off so every existing call site and the live
// PvP format are untouched. These tests exercise the NEW behavior only —
// the full existing `duel.test.ts` suite (mirror-safety/seat-independence
// for the default single-lane path) stays the regression backstop for
// everything that must NOT change.
//
// Note on scope: the `afterAttack` trigger-dispatch fix (hardcoded index 0
// -> `board.indexOf(front)`, see sim.ts's `resolveClash`) has no dedicated
// test here — verified by inspection that no shipped `afterAttack` effect
// (`healSelf`, `poisonTarget`) actually reads its `index` argument, so the
// bug was already unobservable with any real content; the fix is pure
// future-proofing for an effect that doesn't exist yet.

describe('simulateDuel — two-lane determinism', () => {
  it('is byte-identical across repeated runs with twoLane on', () => {
    const a = L({ defId: 'gutter-runt', tier: 2 }, { defId: 'bramble-rat', tier: 1 });
    const b = L({ defId: 'gutter-runt', tier: 2 }, { defId: 'plate-rat', tier: 1 });
    const opts = { twoLane: true };
    expect(JSON.stringify(simulateDuel(a, b, opts))).toBe(JSON.stringify(simulateDuel(a, b, opts)));
  });
});

describe('simulateDuel — twoLane default-off backward compatibility', () => {
  const boards: [string, Lineup, Lineup][] = [
    ['single unit', L({ defId: 'gutter-runt', tier: 2 }), L({ defId: 'slink-rat', tier: 2 })],
    [
      'multi-unit PvP roster board',
      L({ defId: 'plate-rat', tier: 1 }, { defId: 'bramble-rat', tier: 1 }, { defId: 'gorge-rat', tier: 1 }),
      L({ defId: 'dire-rat-pvp', tier: 1 }, { defId: 'steel-whisker-pvp', tier: 1 }, { defId: 'grave-leech-pvp', tier: 1 }),
    ],
  ];

  it.each(boards)('%s: no options, {twoLane:false}, and {} all agree', (_label, a, b) => {
    const bare = simulateDuel(a, b);
    const explicitFalse = simulateDuel(a, b, { twoLane: false });
    const emptyOptions = simulateDuel(a, b, {});
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(bare));
    expect(JSON.stringify(emptyOptions)).toBe(JSON.stringify(bare));
  });
});

describe('simulateDuel — two-lane mirror fairness', () => {
  // Direct two-lane analog of duel.test.ts's roster-wide invariant. A
  // single-unit board only ever populates lane 1 (lane 2 stays empty by
  // construction, ceil(1/2)=1) — a degenerate but important smoke test that
  // twoLane never breaks a plain single-lane-shaped duel for any unit.
  it.each(ROSTER)('two-lane single-copy mirror of %s draws', (id) => {
    const board = L({ defId: id, tier: 2 });
    const r = simulateDuel(board, board, { twoLane: true }).result;
    expect(r.winner).toBe('draw');
    expect(r.healthA).toBe(r.healthB);
  });

  // Exercises the actual ceil(n/2) lane split across even AND odd board
  // sizes, using an ability-bearing unit (onHurt reflect) so lane resolution
  // isn't just bare stat trading.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('a %i-unit two-lane mirror board draws', (n) => {
    const units = Array.from({ length: n }, () => ({ defId: 'bramble-rat', tier: 1 }));
    const board = L(...units);
    const r = simulateDuel(board, board, { twoLane: true }).result;
    expect(r.winner).toBe('draw');
    expect(r.healthA).toBe(r.healthB);
    expect(r.survivorsA.length).toBe(r.survivorsB.length);
  });

  it('a mixed multi-role, multi-lane mirror board draws', () => {
    const board = L(
      { defId: 'plate-rat', tier: 1 },
      { defId: 'bramble-rat', tier: 1 },
      { defId: 'gorge-rat', tier: 1 },
      { defId: 'press-kin-pvp', tier: 1 }
    );
    const r = simulateDuel(board, board, { twoLane: true }).result;
    expect(r.winner).toBe('draw');
    expect(r.survivorsA.length).toBe(r.survivorsB.length);
  });
});

describe('simulateDuel — two-lane assignment / clash pairing', () => {
  it('resolves lane 1 and lane 2 as independent simultaneous clashes each tick', () => {
    const board = L(
      { defId: 'gutter-runt', tier: 3 },
      { defId: 'gutter-runt', tier: 3 },
      { defId: 'gutter-runt', tier: 3 },
      { defId: 'gutter-runt', tier: 3 }
    );
    const { events } = simulateDuel(board, board, { twoLane: true });
    const battleStart = ofType(events, 'battleStart')[0];
    const waveStart = ofType(events, 'waveStart')[0];
    // 4-unit board, ceil(4/2)=2: indices 0-1 are lane 1, indices 2-3 are lane 2.
    // The frontmost (lowest-index) survivor of each lane on tick 1 is index 0
    // (lane 1) and index 2 (lane 2).
    const hordeLane1Id = battleStart.horde[0].instanceId;
    const hordeLane2Id = battleStart.horde[2].instanceId;
    const enemyLane1Id = waveStart.enemies[0].instanceId;
    const enemyLane2Id = waveStart.enemies[2].instanceId;

    const firstTickClashes = ofType(events, 'clash').slice(0, 2);
    expect(firstTickClashes).toHaveLength(2);
    expect(firstTickClashes).toContainEqual({ type: 'clash', hordeId: hordeLane1Id, enemyId: enemyLane1Id });
    expect(firstTickClashes).toContainEqual({ type: 'clash', hordeId: hordeLane2Id, enemyId: enemyLane2Id });
  });
});

describe('simulateDuel — two-lane no reach-across', () => {
  it("a lane's winner does not attack the other lane once its own opponent is gone", () => {
    // Lane 1: A's tier-3 gutter-runt (9/9) vs B's tier-1 gutter-runt (1/1) —
    // resolves in exactly 1 tick, A's unit survives at 8hp, B's dies.
    // Lane 2: identical tier-1 bramble-rat (1/9) mirror on both sides —
    // each tick both take 1 (clash) + 4 (onHurt reflectDamage) = 5 damage,
    // simultaneously: 9 -> 4 -> -1, mutually killing on tick 2.
    const a = L({ defId: 'gutter-runt', tier: 3 }, { defId: 'bramble-rat', tier: 1 });
    const b = L({ defId: 'gutter-runt', tier: 1 }, { defId: 'bramble-rat', tier: 1 });
    const { events, result } = simulateDuel(a, b, { twoLane: true });

    const battleStart = ofType(events, 'battleStart')[0];
    const hordeLane1Id = battleStart.horde[0].instanceId; // A's tier-3 gutter-runt

    // If lane 1's surviving unit ever attacked again (reaching across into
    // lane 2), it would appear as a clash participant more than once.
    const clashesInvolvingHordeLane1 = ofType(events, 'clash').filter((c) => c.hordeId === hordeLane1Id);
    expect(clashesInvolvingHordeLane1).toHaveLength(1);

    // Lane 2's mirror trade should still run its full 2-tick course
    // independently, undisturbed by lane 1 already being decided.
    const battleUnits = new Set(battleStart.horde.map((u) => u.instanceId));
    const lane2ClashesCount = ofType(events, 'clash').filter((c) => c.hordeId !== hordeLane1Id).length;
    expect(lane2ClashesCount).toBe(2);
    expect(battleUnits.size).toBe(2);

    // Both sides lose their lane-2 unit (mutual kill); B's lane-1 unit died
    // turn 1; A's lane-1 unit was never touched again. Net: B fully wiped,
    // A has exactly its untouched lane-1 survivor left.
    expect(result.winner).toBe('a');
    expect(result.survivorsA).toHaveLength(1);
    expect(result.survivorsB).toHaveLength(0);
    expect(result.survivorsA[0].health).toBe(8);
  });
});

describe('simulateDuel — two-lane cross-lane stranding (documented tradeoff)', () => {
  it('resolves via the health/attack tiebreak when both lanes decide in opposite directions, leaving no shared lane', () => {
    // Lane 1: A's tier-3 (9/9) crushes B's tier-1 (1/1) -> A survives at 8hp.
    // Lane 2: B's tier-3 (9/9) crushes A's tier-1 (1/1) -> B survives at 8hp.
    // After tick 1 neither side is wiped, but neither lane has a live
    // opponent left either — by design (no reach-across) this is NOT
    // resolved as a fight; it falls through to the stalemate tiebreak.
    // This documents the accepted tradeoff from the B2 plan rather than
    // asserting it "shouldn't happen."
    const a = L({ defId: 'gutter-runt', tier: 3 }, { defId: 'gutter-runt', tier: 1 });
    const b = L({ defId: 'gutter-runt', tier: 1 }, { defId: 'gutter-runt', tier: 3 });
    const { result } = simulateDuel(a, b, { twoLane: true });

    expect(result.survivorsA).toHaveLength(1);
    expect(result.survivorsB).toHaveLength(1);
    expect(result.healthA).toBe(8);
    expect(result.healthB).toBe(8);
    // Equal health -> falls to the attack tiebreak -> also equal (both are
    // tier-3 gutter-runt survivors) -> true draw.
    expect(result.winner).toBe('draw');
  });
});

describe('simulateDuel — symmetric cleaveOverkill (Milestone B2 fix)', () => {
  it("a foe's cleaveOverkill relic now spills onto the horde's next unit too", () => {
    // Previously only `front`'s (horde-side) cleaveOverkill was ever
    // consulted — a mirror match with the relic on both sides didn't draw
    // (side A's cleave always "went first"). This is the missing direction:
    // B's single 9/9 unit (Gore-Cleaver equipped) kills A's front (1hp) with
    // 8 overkill, which should now spill onto A's second unit (1hp) too.
    const a = L({ defId: 'gutter-runt', tier: 1 }, { defId: 'gutter-runt', tier: 1 });
    const b = L({ defId: 'gutter-runt', tier: 3, relicIds: ['gore-cleaver'] });
    const r = simulateDuel(a, b).result;
    expect(r.survivorsA).toHaveLength(0);
    expect(r.winner).toBe('b');
  });
});
