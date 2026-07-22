# PvP first playtest — runbook

The lean manual round. Code is built and verified locally (341 tests green, the
`?mode=pvp` screen renders + the allocator/budget work). The steps below are the
**Jesper-only** operational bits (Supabase + deploy + running each round).

## One-time setup

1. **Apply the migration.** Run `supabase/migrations/2026-07-22-add-pvp.sql`
   against the live project (`wvrllhiktnkvbpclmrpq`) via the Supabase SQL editor
   (or CLI). It creates `pvp_boards`, `pvp_results`, and the `submit_pvp_board`
   RPC with RLS (anon read; writes via the RPC / service key only). It is
   idempotent (`if not exists` / `create or replace`).

2. **Local `.env` for the round runner.** Create `./.env` (repo root) with the
   **service-role** key (Supabase dashboard → Project Settings → API →
   `service_role`, *not* the anon key):

   ```
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```

   `.env` is gitignored — never commit it. Without it, `run-round` still works
   in **dry-run** (prints standings, writes nothing).

## Each round

1. **Open the round.** Deploy the dev channel: push to the `dev` branch →
   GitHub Pages builds `/dev/`. Players open:

   ```
   https://<your-pages-domain>/dev/?mode=pvp          (round r1, the default)
   https://<your-pages-domain>/dev/?mode=pvp&round=r2  (later rounds)
   ```

   The dev channel prefixes the round id with `dev-`, so `?round=r1` submits to
   round **`dev-r1`**. Players spend 100 scrap, build a board, hit **Submit**.

2. **Close the round.** Once submissions are in, run the all-vs-all and write
   standings (note the `dev-` prefix — it must match what the client submitted):

   ```bash
   npm run run-round -- dev-r1
   ```

   Run it once without the key first if you want a dry-run preview. With the key
   present it writes `pvp_results`.

3. **Players see results.** They revisit the same URL → **Standings** tab shows
   the ranked board and their own matchups, each replayable in the Pixi stage
   (the client re-simulates each duel locally — deterministic, so it matches).

4. **Next round.** Share `?round=r2`, players rebuild, then
   `npm run run-round -- dev-r2`. Watching the **meta rotate** across rounds
   (does the counter to last round's popular archetype win?) is the main thing
   this test is for.

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
