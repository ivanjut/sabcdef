-- ─────────────────────────────────────────────────────────────────────────────
-- TierDrop daily global averages — scheduling + backfill
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this AFTER schema.sql (which creates public.daily_averages and the
-- public.snapshot_daily_averages(text) function) and AFTER categories-seed.sql
-- (so the backfilled averages carry item ids + names; without it they still
-- compute, just with null id/name). Safe to re-run: the schedule is replaced and
-- the snapshot upserts by day.
--
-- What it does:
--   1. Schedules a daily job that snapshots the just-closed TierDrop day.
--   2. Backfills every day already present in public.tier_lists.
-- ─────────────────────────────────────────────────────────────────────────────

-- pg_cron is available on Supabase; enabling is idempotent.
create extension if not exists pg_cron;

-- ── 1. Daily snapshot of the just-closed day ──────────────────────────────────
-- The category (and thus a day's submission window) rolls at 05:00 UTC — see
-- CATEGORY_SWITCH_UTC_HOUR in public/app.js. We run at 06:00 UTC, an hour after
-- the roll-over, and snapshot the day that just closed: the TierDrop day for
-- (now − 5h) is the current day, so (now − 5h − 1 day) is the one that just ended.
-- Once closed a day is immutable (the app only ever submits for the current day),
-- so that snapshot is final.
do $$ begin
  perform cron.unschedule('tierdrop-daily-averages');
exception when others then null;  -- not scheduled yet → nothing to drop
end $$;

select cron.schedule(
  'tierdrop-daily-averages',
  '0 6 * * *',   -- 06:00 UTC daily
  $$
  select public.snapshot_daily_averages(
    to_char((now() - interval '5 hours' - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD')
  );
  $$
);

-- ── 2. One-time backfill ──────────────────────────────────────────────────────
-- Snapshot every day already present in tier_lists. Idempotent (upserts by day),
-- so re-running this file just refreshes the rows. Today's still-open day is
-- included; tomorrow's scheduled run will finalize it.
do $$
declare d text;
begin
  for d in select distinct day from public.tier_lists order by day loop
    perform public.snapshot_daily_averages(d);
  end loop;
end $$;
