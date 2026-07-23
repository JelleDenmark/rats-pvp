# PvP first playtest — runbook

The lean manual round. **Live and deployed**: https://github.com/JelleDenmark/rats-pvp
→ https://jelledenmark.github.io/rats-pvp/?mode=pvp (public repo, `master` branch,
single-branch GitHub Pages deploy — no `dev` channel in this fork, so round ids
are **unprefixed**). 341 tests green; the migration is applied to the live
Supabase project and the full submit → run-round → standings loop has been
verified end-to-end against the deployed page.

## One-time setup (done)

1. ~~Apply the migration~~ — `supabase/migrations/2026-07-22-add-pvp.sql` is
   applied to the live project (`wvrllhiktnkvbpclmrpq`): `pvp_boards`,
   `pvp_results`, `submit_pvp_board` RPC, RLS all live. Re-running it is safe
   (idempotent `if not exists` / `create or replace`) if you ever need to.

2. ~~Local `.env`~~ — `./.env` (repo root, gitignored) already has
   `SUPABASE_SERVICE_ROLE_KEY` set, so `run-round` writes real results (not
   dry-run).

3. ~~Deploy~~ — pushed to `master`, GitHub Pages is live (single-branch workflow,
   `.github/workflows/deploy.yml`). Future pushes to `master` redeploy
   automatically.

## Each round

1. **Open the round.** Share the URL — round id is unprefixed:

   ```
   https://jelledenmark.github.io/rats-pvp/?mode=pvp          (round r1, the default)
   https://jelledenmark.github.io/rats-pvp/?mode=pvp&round=r2  (later rounds)
   ```

   Players spend 100 scrap, build a board, hit **Submit**.

2. **Close the round.** Once submissions are in, run the all-vs-all and write
   standings. Two ways:

   - **Phone / browser (no terminal)** — GitHub → **Actions** tab → **Rats
     control** → **Run workflow**. Pick `action: run`, `round: r1`, tap the
     green button. Works from the GitHub mobile app too. `action: status` first
     is a safe preview (writes nothing); `action: reset` wipes a round (retype
     the round id in `confirm_round` to arm it). See `.github/workflows/rats-control.yml`.
   - **Terminal** — still available:

     ```bash
     npm run run-round -- r1
     ```

   The control workflow needs the `SUPABASE_SERVICE_ROLE_KEY` **repo secret**
   set once (Settings → Secrets and variables → Actions) — same value as the
   local `.env`. Without it, `run`/`reset` fall back to a harmless dry-run.

3. **Players see results.** They revisit the same URL → **Standings** tab shows
   the ranked board and their own matchups, each replayable in the Pixi stage
   (the client re-simulates each duel locally — deterministic, so it matches).

4. **Next round.** Share `?round=r2`, players rebuild, then
   `npm run run-round -- r2`. Watching the **meta rotate** across rounds (does
   the counter to last round's popular archetype win?) is the main thing this
   test is for.

## What to watch for in the test
- Is building a board + anticipating the field **fun**?
- Is the WALL▸THORN▸BRUISER counter triangle **legible** to players?
- Is the scoring right? It's football points (win 3 / draw 1 / loss 0) with
  survivor differential as the tiebreak — deliberately not too swingy. Easy to
  retune in `run-round.ts` (e.g. reward margin more, or less).

## Not in this version (deferred — see pvp-notes.md)
Automated 2-hour rounds (GitHub Actions cron → an edge-function runner mirroring
`verify-scores`), anti-cheat re-simulation, and richer builder features. All have
existing templates in the repo to copy when you want them.
