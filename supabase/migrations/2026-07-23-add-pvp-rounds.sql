-- Rats PvP — round lifecycle (Milestone A: automate + anti-cheat).
--
-- Today "closed" is implied only by pvp_results existing (2026-07-22-add-pvp.sql
-- has no round-status column at all), and nothing stops a late submission —
-- that migration's header says so explicitly ("anti-cheat: none in v1").
-- This adds an explicit round-lifecycle table so:
--   * the submit RPC can enforce a server-authoritative cutoff (not the
--     client's clock), and
--   * the client can show a real "closes in HH:MM" countdown instead of
--     inferring state from whether pvp_results has rows.
--
-- DO NOT RUN THIS AUTOMATICALLY. Apply by hand against the live Supabase
-- project (wvrllhiktnkvbpclmrpq) via the SQL editor or CLI.
--
-- Arity note (same guard as submit_score / submit_boss_trial): submit_pvp_board
-- already exists (2026-07-22-add-pvp.sql) with signature (text, uuid, text,
-- jsonb). This migration's `create or replace` keeps that EXACT signature —
-- only the body changes — so it genuinely replaces the existing function, no
-- second overload, no PGRST203.
--
-- After applying, seed the first round (nothing is open until you do — every
-- submission is rejected otherwise):
--     npm run advance-round -- --dry     # preview: should offer to open r1
--     npm run advance-round --           # for real
-- packages/core/scripts/advance-round.ts is the cron entry point
-- (.github/workflows/rats-cron.yml) that keeps doing this automatically.

-- 1. Round lifecycle. One row per round id. `status` transitions
--    open -> scoring -> closed as advance-round.ts / run-round.ts process it.
create table if not exists public.pvp_rounds (
  round_id   text primary key,
  opens_at   timestamptz not null default now(),
  closes_at  timestamptz not null,
  status     text not null default 'open' check (status in ('open', 'scoring', 'closed')),
  created_at timestamptz not null default now()
);

-- 2. Public READ, exactly like pvp_boards / pvp_results. No anon write policy —
--    only the service-role key (bypasses RLS) opens/closes rounds.
grant select on public.pvp_rounds to anon;
alter table public.pvp_rounds enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where schemaname='public' and tablename='pvp_rounds'
                   and policyname='pvp rounds public read') then
    create policy "pvp rounds public read"
      on public.pvp_rounds for select to anon using (true);
  end if;
end
$$;

-- 3. submit_pvp_board gains a server-authoritative cutoff: reject unless a
--    pvp_rounds row for p_round is 'open' and its closes_at hasn't passed yet.
--    Body is otherwise the 2026-07-22 version verbatim (name truncation,
--    last-write-wins upsert on (round_id, device_id)).
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
  if not exists (
    select 1 from public.pvp_rounds
    where round_id = p_round and status = 'open' and now() < closes_at
  ) then
    raise exception 'round % is not open for submissions', p_round;
  end if;

  insert into public.pvp_boards as b (round_id, device_id, name, lineup, submitted_at)
  values (p_round, p_device, left(coalesce(nullif(p_name,''),'Rat'),24), p_lineup, now())
  on conflict (round_id, device_id) do update set
    name         = excluded.name,
    lineup       = excluded.lineup,
    submitted_at = now();
end;
$function$;

grant execute on function public.submit_pvp_board(text, uuid, text, jsonb) to anon;
