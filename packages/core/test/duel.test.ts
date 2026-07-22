import { describe, expect, it } from 'vitest';
import { simulateDuel } from '../src/duel';
import { UNIT_DEFS, type Lineup } from '../src/data/units';

const L = (...units: Lineup['units']): Lineup => ({ units });
const ROSTER = Object.keys(UNIT_DEFS).filter((id) => id !== 'pup');

describe('simulateDuel — determinism', () => {
  it('is byte-identical across repeated runs (same inputs -> same log + result)', () => {
    const a = L({ defId: 'gutter-runt', tier: 2 }, { defId: 'slink-rat', tier: 2 });
    const b = L({ defId: 'gutter-runt', tier: 2 }, { defId: 'brood-mother', tier: 2 });
    expect(JSON.stringify(simulateDuel(a, b))).toBe(JSON.stringify(simulateDuel(a, b)));
  });
});

describe('simulateDuel — mirror fairness (side symmetry)', () => {
  // The whole PvP model rests on there being no inherent side-A advantage:
  // a board fought against an identical copy of itself MUST draw, or the
  // ladder would reward whoever the matchmaker happened to seat as side A.
  // The front clash is simultaneous and both sides run the identical engine,
  // so this should hold for every unit — including faint/summon/poison kits
  // whose death-resolution runs "horde before gauntlet".
  it.each(ROSTER)('single-copy mirror of %s draws', (id) => {
    const board = L({ defId: id, tier: 2 });
    const r = simulateDuel(board, board).result;
    expect(r.winner).toBe('draw');
    expect(r.healthA).toBe(r.healthB);
  });

  it('a mixed multi-role mirror board draws', () => {
    const board = L(
      { defId: 'gutter-runt', tier: 2 },
      { defId: 'brood-mother', tier: 2 },
      { defId: 'slink-rat', tier: 2 },
      { defId: 'plague-bearer', tier: 2 }
    );
    const r = simulateDuel(board, board).result;
    expect(r.winner).toBe('draw');
    expect(r.survivorsA.length).toBe(r.survivorsB.length);
  });
});

describe('simulateDuel — winner is independent of seating', () => {
  it('a strictly stronger board wins from either seat', () => {
    const strong = L({ defId: 'gutter-runt', tier: 3 }, { defId: 'gutter-runt', tier: 3 });
    const weak = L({ defId: 'gutter-runt', tier: 1 });
    expect(simulateDuel(strong, weak).result.winner).toBe('a');
    expect(simulateDuel(weak, strong).result.winner).toBe('b');
  });
});
