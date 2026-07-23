import { describe, it, expect } from 'vitest';
import { scoreRound, legalEntrants, type PvpEntrant } from '../src';

const entrant = (id: string, defIds: string[]): PvpEntrant => ({
  id,
  name: id,
  lineup: { units: defIds.map((defId) => ({ defId, tier: 1, relicIds: [] })) },
});

describe('legalEntrants', () => {
  it('keeps legal boards and drops illegal ones, preserving order of the kept', () => {
    const legal = entrant('a', ['plate-rat']);
    const illegal = entrant('b', ['pup']); // pup is a PvE unit, not pvpOnly
    const legal2 = entrant('c', ['bramble-rat']);
    const { entrants, dropped } = legalEntrants([legal, illegal, legal2]);
    expect(entrants.map((e) => e.id)).toEqual(['a', 'c']);
    expect(dropped).toEqual([{ id: 'b', name: 'b', reason: expect.stringMatching(/not a PvP unit/i) }]);
  });
});

describe('scoreRound', () => {
  it('draws every mirror board (0-0-N, margin 0) — seat symmetry holds at round scale', () => {
    const a = entrant('a', ['plate-rat', 'plate-rat']);
    const b = entrant('b', ['plate-rat', 'plate-rat']);
    const rows = scoreRound([a, b]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.wins).toBe(0);
      expect(r.losses).toBe(0);
      expect(r.draws).toBe(2); // home + away
      expect(r.margin).toBe(0);
      expect(r.score).toBe(2); // 2 draws * 1 point
    }
  });

  it('ranks the counter-triangle winner above the unit it beats, both seatings counted', () => {
    // Per the shipped roster: BRUISER (gorge-rat) beats WALL (plate-rat).
    const wall = entrant('wall', ['plate-rat']);
    const bruiser = entrant('bruiser', ['gorge-rat']);
    const rows = scoreRound([wall, bruiser]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.bruiser.wins).toBe(2); // home + away
    expect(byId.bruiser.losses).toBe(0);
    expect(byId.wall.losses).toBe(2);
    expect(rows[0].id).toBe('bruiser');
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
  });

  it('breaks ties in points by survivor-differential margin', () => {
    // Three players, each 1-1 in points against the others but different
    // survivor margins — margin should determine final ranking order.
    const a = entrant('a', ['plate-rat', 'plate-rat', 'plate-rat']); // biggest board
    const b = entrant('b', ['plate-rat']);
    const c = entrant('c', ['bramble-rat']); // loses to a's wall stack, beats nothing extra
    const rows = scoreRound([a, b, c]);
    // Sanity: sorted descending by score then margin.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].score > rows[i].score || (rows[i - 1].score === rows[i].score && rows[i - 1].margin >= rows[i].margin)).toBe(true);
    }
  });
});
