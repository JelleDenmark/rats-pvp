import type { Lineup } from './data/units';
import { simulateCore, type BattleEvent, type UnitView } from './sim';

/**
 * Outcome of a single symmetric board-vs-board duel (the PvP core loop).
 *
 * A duel is one wave: side A's board fought to the death against side B's
 * board, both instantiated with full tiers, per-unit relics and team relics
 * and no wave scaling (see `simulateCore`'s `duel` mode). Because the front
 * clash is simultaneous and both sides run through the identical engine, the
 * matchup is mechanically symmetric — a mirror (A === B) resolves to `draw`.
 */
export interface DuelResult {
  winner: 'a' | 'b' | 'draw';
  survivorsA: UnitView[];
  survivorsB: UnitView[];
  /** Total remaining health of each side's survivors. The margin used to break
   * a stalemate, and a natural "how decisive" signal for rating updates. */
  healthA: number;
  healthB: number;
  /** Damage side A dealt to side B (clash + poison). Symmetric B-damage is not
   * tracked by the core; use survivor health as the neutral margin instead. */
  damageA: number;
  /** Opponent (side B) units side A felled. */
  defeatedB: number;
}

/**
 * Resolve a PvP duel between two player boards. Deterministic: the same
 * `(a, b)` always yields a byte-identical event log and result, so a client
 * and the server can independently re-simulate and agree (the anti-cheat
 * story). The returned `BattleEvent[]` is the standard log the Pixi replay
 * renders, unchanged.
 *
 * Winner rules:
 * - exactly one side wiped  -> the survivor wins;
 * - both wiped (simultaneous) -> `draw`;
 * - both still standing at the stalemate guard -> higher surviving health
 *   wins, then higher surviving attack, else `draw`.
 */
export function simulateDuel(
  a: Lineup,
  b: Lineup
): { events: BattleEvent[]; result: DuelResult } {
  const { events, result, enemySurvivors } = simulateCore(a, { kind: 'duel', opponent: b });
  const survivorsA = result.survivors;
  const survivorsB = enemySurvivors;
  const healthA = survivorsA.reduce((s, u) => s + u.health, 0);
  const healthB = survivorsB.reduce((s, u) => s + u.health, 0);

  const aAlive = survivorsA.length > 0;
  const bAlive = survivorsB.length > 0;
  let winner: 'a' | 'b' | 'draw';
  if (aAlive && !bAlive) winner = 'a';
  else if (bAlive && !aAlive) winner = 'b';
  else if (!aAlive && !bAlive) winner = 'draw';
  else {
    // Both boards still standing when the stalemate guard tripped: decide by
    // margin so the ladder still moves. Health, then attack, then a true draw.
    if (healthA > healthB) winner = 'a';
    else if (healthB > healthA) winner = 'b';
    else {
      const atkA = survivorsA.reduce((s, u) => s + u.attack, 0);
      const atkB = survivorsB.reduce((s, u) => s + u.attack, 0);
      winner = atkA > atkB ? 'a' : atkB > atkA ? 'b' : 'draw';
    }
  }

  return {
    events,
    result: {
      winner,
      survivorsA,
      survivorsB,
      healthA,
      healthB,
      damageA: result.damageDealt,
      defeatedB: result.enemiesDefeated,
    },
  };
}
