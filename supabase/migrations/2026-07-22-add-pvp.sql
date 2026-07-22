-- Rats PvP — first-playtest backend (lean manual round).
--
-- Two brand-new independent tables + one submit RPC, parallel to the existing
-- `scores` / `submit_score` setup (2026-07-06-add-kills.sql) — NOT a change to
-- any existing table:
--   * pvp_boards  — the board each device submitted for a given round.
--   * pvp_results — the standings a round produced (written by the manual
--                   round runner, packages/core/scripts/run-round.ts).
--
-- DO NOT RUN THIS AUTOMATICALLY. Apply by hand against the live Supabase
-- project (wvrllhiktnkvbpclmrpq) via the SQL editor or CLI before the PvP app
-- code ships — the client calls submit_pvp_board and reads both tables directly
-- (PostgREST GET), and all of that no-ops until this migration is applied.
--
-- Arity note (same guard as submit_boss_trial / submit_score): submit_pvp_board
-- is a brand-new function name with no prior overload, so `create or replace`
-- is safe as a first apply. If its signature is EVER changed later, that change
-- must `drop function if exists public.submit_pvp_board(<old signature>)` in
-- the same migration, or PostgREST will see two candidates and every old-shaped
-- call fails silently (PGRST203).
--
-- Anti-cheat: none in v1. Boards are entirely client-trusted (a friendly test).
-- The deferred edge-function round runner (mirror of verify-scores) is where
-- server-side re-simulation would live later.

-- 1. Submitted boards. One row per device per round, keyed (round_id,
--    device_id) so a resubmit before the round runs upserts in place. Unlike
--    the score boards this is NOT monotonic — the latest board a player submits
--    for the round simply wins (you're allowed to change your mind pre-round).
create table if not exists public.pvp_boards (
  round_id     text not null,
  device_id    uuid not null,
  name         text not null,
  lineup       jsonb not null,
  submitted_at timestamptz not null default now(),
  primary key (round_id, device_id)
);

-- 2. Round standings, written by the manual runner with the SERVICE-ROLE key
--    (which bypasses RLS), read by everyone. One row per device per round.
-- `score` is match points (3 per win + 1 per draw). `margin` is the survivor
-- differential (Σ your survivors − their survivors) — the "goal difference"
-- tiebreak, kept separate so the headline score isn't swingy.
create table if not exists public.pvp_results (
  round_id   text not null,
  device_id  uuid not null,
  name       text not null,
  score      integer not null default 0,
  margin     integer not null default 0,
  wins       integer not null default 0,
  losses     integer not null default 0,
  draws      integer not null default 0,
  rank       integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (round_id, device_id)
);

-- 3. Public READ on both, exactly like `scores` / `boss_trial_scores`.
--    RLS IS LOAD-BEARING — do not drop it. Without RLS the anon key (shipped in
--    the client bundle) inherits INSERT/UPDATE/DELETE on new public tables, so
--    anyone could raw-POST past the submit RPC, overwrite others' boards, or
--    truncate the tables. RLS-on + a lone read policy reduces anon to SELECT;
--    the security-definer RPC below is what performs writes.
grant select on public.pvp_boards  to anon;
grant select on public.pvp_results to anon;
alter table public.pvp_boards  enable row level security;
alter table public.pvp_results enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='pvp_boards'
                   and policyname='pvp boards public read') then
    create policy "pvp boards public read"
      on public.pvp_boards for select to anon using (true);
  end if;
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='pvp_results'
                   and policyname='pvp results public read') then
    create policy "pvp results public read"
      on public.pvp_results for select to anon using (true);
  end if;
end
$$;

-- 4. Submit RPC — security definer so it bypasses RLS and is the only write
--    path anon has to pvp_boards. Simple last-write-wins upsert (no greatest()).
create or replace function public.submit_pvp_board(
  p_round text,
  p_device uuid,
  p_name text,
  p_lineup jsonb
)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into public.pvp_boards as b (round_id, device_id, name, lineup, submitted_at)
  values (p_round, p_device, left(coalesce(nullif(p_name,''),'Rat'),24), p_lineup, now())
  on conflict (round_id, device_id) do update set
    name         = excluded.name,
    lineup       = excluded.lineup,
    submitted_at = now();
end;
$function$;

grant execute on function public.submit_pvp_board(text, uuid, text, jsonb) to anon;
