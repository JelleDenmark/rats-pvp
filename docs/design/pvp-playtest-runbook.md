# PvP playtest — runbook

**Live and deployed**: https://github.com/JelleDenmark/rats-pvp
→ https://jelledenmark.github.io/rats-pvp/?mode=pvp (public repo, `master` branch,
single-branch GitHub Pages deploy — no `dev` channel in this fork, so round ids
are **unprefixed**).

As of Milestone A (2026-07-23), the round loop is **automated and board-legality
is server-enforced** — see "Milestone A" in `pvp-notes.md` for the design
rationale. The manual control panel (`rats-control.yml`) still works as an
operator override.

## One-time setup

1. ~~Apply the boards/results migration~~ — `supabase/migrations/2026-07-22-add-pvp.sql`
   is applied to the live project (`wvrllhiktnkvbpclmrpq`): `pvp_boards`,
   `pvp_results`, `submit_pvp_board` RPC, RLS all live.

2. **Apply the round-lifecycle migration** (new, not yet applied) —
   `supabase/migrations/2026-07-23-add-pvp-rounds.sql` adds `pvp_rounds` and
   the closed-round guard in `submit_pvp_board`. Apply by hand (SQL editor or
   CLI) against `wvrllhiktnkvbpclmrpq`, same as every prior migration in this
   repo. **Until this is applied, `advance-round.ts`/the cron fail loudly**
   (the table doesn't exist) and the client falls back to its old default of
   round `r1` with no countdown — safe, but not the new behavior.

3. **Seed the first round** (new, one-time, right after applying #2) — nothing
   is open until you do this; every submission is rejected otherwise:

   ```bash
   npm run advance-round -- --dry     # preview: should say "opening round r1"
   npm run advance-round --           # for real
   ```

4. **Set the `SUPABASE_SERVICE_ROLE_KEY` repo secret** (done) — Settings →
   Secrets and variables → Actions. Used by both `rats-control.yml` (manual)
   and the new `rats-cron.yml` (automatic). Also present in the local `.env`
   (repo root, gitignored) for terminal use.

5. ~~Deploy~~ — pushed to `master`, GitHub Pages is live
   (`.github/workflows/deploy.yml`). Future pushes to `master` redeploy
   automatically.

## How a round works now (automated)

1. **Round opens automatically.** `.github/workflows/rats-cron.yml` runs
   `npm run advance-round -w @wrad/core` every 2 hours. Players just visit:

   ```
   https://jelledenmark.github.io/rats-pvp/?mode=pvp
   ```

   The client asks the server which round is currently open (`pvp_rounds`,
   `status=open`) and shows a **"Round closes in Xh Ym"** countdown. An
   explicit `?round=r2` link still works as an override (testing / old links).

2. **Players build and submit.** Same as before: spend 100 scrap, build a
   board, hit **Submit**. The RPC now rejects a submission once the round has
   closed (`"This round has closed — check Standings."`).

3. **Round closes automatically.** When `closes_at` passes, the next cron
   tick: fetches every submitted board, **drops any that fail PvP legality**
   (`validateBoard` — wrong budget, non-PvP unit, tier > 1, relics; logged in
   the workflow's step summary), runs the all-vs-all round-robin on the rest,
   writes `pvp_results`, marks the round `closed`, and opens the next one.

4. **Players see results.** Same **Standings** tab as before — ranked board,
   own matchups, replayable in the Pixi stage (client re-simulates locally,
   deterministic, so it matches the server).

## Manual override (still available)

Everything from the original manual flow still works, now on top of the round
lifecycle:

- **Phone / browser (no terminal)** — GitHub → **Actions** tab → **Rats
  control** → **Run workflow**. `action: status` previews (writes nothing);
  `action: run` closes the round NOW regardless of its scheduled close time
  (drops illegal boards, writes standings, marks it `closed`); `action: reset`
  wipes a round's boards/results **and re-opens it** (retype the round id in
  `confirm_round` to arm it).
- **Terminal**:
  ```bash
  npm run run-round -- r1          # close round r1 now
  npm run reset-round -- r1 --confirm r1   # wipe + reopen r1
  npm run advance-round -- --dry    # preview what the cron would do next
  ```

## What to watch for in the test
- Is building a board + anticipating the field **fun**?
- Is the WALL▸THORN▸BRUISER counter triangle **legible** to players?
- Is the scoring right? Football points (win 3 / draw 1 / loss 0) with
  survivor differential as the tiebreak — tune via `scoreRound` in
  `packages/core/src/pvp.ts` (the single implementation the live runner, the
  cron, and `round-sim.ts` all share).
- Is 2 hours the right round length now that it's unattended? `advance-round
  -- --hours <n>` controls the NEXT round's length.

## Not in this version (deferred — see pvp-notes.md)
Server-side anti-cheat is now board-legality only (a forged board can't be
scored) — full outcome re-simulation was already implicit (the runner computes
every duel itself from the submitted boards). Richer combat (positional
targeting, multi-wave duels), seasons/rotating meta, and ranks/cosmetics are
Milestones B–D in the long-term plan, not started yet.
