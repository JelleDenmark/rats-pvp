import { describe, it, expect } from 'vitest';
import {
  validateBoard,
  pvpUnitCost,
  PVP_BUDGET,
  PVP_BOARD_CAP,
  PVP_ROSTER,
  type Lineup,
} from '../src';

const board = (units: Lineup['units'], extra: Partial<Lineup> = {}): Lineup => ({ units, ...extra });
const plate = (n: number) => Array.from({ length: n }, () => ({ defId: 'plate-rat', tier: 1, relicIds: [] }));

describe('pvpUnitCost', () => {
  it('is the flat PvP unit cost at tier 1', () => {
    expect(pvpUnitCost('plate-rat')).toBe(16);
  });
  it('is zero for an unknown unit', () => {
    expect(pvpUnitCost('does-not-exist')).toBe(0);
  });
  it('scales by the 3^(tier-1) power curve', () => {
    expect(pvpUnitCost('plate-rat', 2)).toBe(48);
    expect(pvpUnitCost('plate-rat', 3)).toBe(144);
  });
});

describe('validateBoard', () => {
  it('accepts a legal board within budget and cap', () => {
    // 6 * 16 = 96 <= 100
    expect(validateBoard(board(plate(6)))).toEqual({ ok: true });
  });

  it('accepts every single-unit board in the shipped roster', () => {
    for (const r of PVP_ROSTER) {
      expect(validateBoard(board([{ defId: r.defId, tier: 1, relicIds: [] }]))).toEqual({ ok: true });
    }
  });

  it('rejects an empty board', () => {
    expect(validateBoard(board([]))).toMatchObject({ ok: false });
    expect(validateBoard(board([])).reason).toMatch(/empty/i);
  });

  it('rejects more than the board cap', () => {
    const res = validateBoard(board(plate(PVP_BOARD_CAP + 1)));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/too many/i);
  });

  it('rejects an over-budget board that is still within the cap', () => {
    // 7 * 16 = 112 > 100, and 7 <= 8 so the cap check passes first
    const res = validateBoard(board(plate(7)));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/over budget/i);
  });

  it('rejects an unknown unit id', () => {
    const res = validateBoard(board([{ defId: 'ghost-rat', tier: 1, relicIds: [] }]));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/unknown/i);
  });

  it('rejects a non-PvP (PvE) unit', () => {
    // `pup` exists in UNIT_DEFS but is not flagged pvpOnly
    const res = validateBoard(board([{ defId: 'pup', tier: 1, relicIds: [] }]));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not a PvP unit/i);
  });

  it('rejects a unit above tier 1', () => {
    const res = validateBoard(board([{ defId: 'plate-rat', tier: 3, relicIds: [] }]));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/tier/i);
  });

  it('rejects a unit carrying relics', () => {
    const res = validateBoard(board([{ defId: 'plate-rat', tier: 1, relicIds: ['rusted-nail'] }]));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/relic/i);
  });

  it('rejects team relics', () => {
    const res = validateBoard(board(plate(1), { teamRelicIds: ['filth-totem'] }));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/team relic/i);
  });

  it('treats a missing tier as tier 1', () => {
    expect(validateBoard(board([{ defId: 'plate-rat' }]))).toEqual({ ok: true });
  });
});
