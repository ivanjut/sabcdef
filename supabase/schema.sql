-- sabcdef forum schema for Supabase.
-- Run this once in your project's SQL Editor (Dashboard → SQL → New query).
-- It is safe to re-run.

-- ── Table ───────────────────────────────────────────────────────────────────
create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  day         text        not null,              -- YYYY-MM-DD the comment belongs to
  parent_id   bigint      references public.comments(id) on delete cascade,
  author      text        not null default 'anon',
  country     text,                              -- author's ISO 3166-1 alpha-2 country code (optional)
  body        text        not null,
  tier_list   text,                              -- the author's whole tier list (all items) at post time (positional encoding; see encodeTierList in app.js)
  score       integer     not null default 1,    -- starts at 1 (author's implicit upvote)
  created_at  timestamptz not null default now(),
  constraint body_len      check (char_length(body) between 1 and 4000),
  constraint author_len    check (char_length(author) <= 32),
  constraint country_len   check (country is null or char_length(country) <= 2),
  constraint tier_list_len check (tier_list is null or char_length(tier_list) <= 64)
);

-- Migrate older tables: the former `ranking` column held the author's whole tier
-- list, so it's renamed to `tier_list`. (An individual item's placement is a
-- "ranking"; the full board is a "tier list".) Also backfill columns that
-- predate this schema.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'comments' and column_name = 'ranking')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'comments' and column_name = 'tier_list') then
    alter table public.comments rename column ranking to tier_list;
  end if;
end $$;

alter table public.comments add column if not exists tier_list text;
alter table public.comments add column if not exists country text;

alter table public.comments drop constraint if exists ranking_len;
do $$ begin
  alter table public.comments
    add constraint tier_list_len check (tier_list is null or char_length(tier_list) <= 64);
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.comments
    add constraint country_len check (country is null or char_length(country) <= 2);
exception when duplicate_object then null;
end $$;

-- A suggestion is just a comment with kind = 'suggestion'; its body is the
-- suggested item name. Suggestions are posted from the "Suggest an item" box,
-- can be replied to and up/downvoted like any comment, and additionally collect
-- S–F "tier reactions" (see the suggestion_reactions table below).
alter table public.comments add column if not exists kind text not null default 'comment';
do $$ begin
  alter table public.comments
    add constraint kind_valid check (kind in ('comment', 'suggestion'));
exception when duplicate_object then null;
end $$;

create index if not exists comments_day_idx    on public.comments (day);
create index if not exists comments_parent_idx on public.comments (parent_id);

-- ── Row Level Security ───────────────────────────────────────────────────────
-- The browser uses the public "anon" key, so RLS is what actually protects the
-- table. We allow: read everything, insert a new comment (score forced to 1),
-- and nothing else directly. Voting goes through the function below.
alter table public.comments enable row level security;

drop policy if exists "read comments"   on public.comments;
drop policy if exists "insert comments" on public.comments;

create policy "read comments" on public.comments
  for select
  using (true);

create policy "insert comments" on public.comments
  for insert
  with check (
    char_length(body) between 1 and 4000
    and char_length(coalesce(author, 'anon')) <= 32
    and (country is null or char_length(country) <= 2)
    and (tier_list is null or char_length(tier_list) <= 64)
    and score = 1            -- clients cannot seed an inflated score
  );

-- No UPDATE or DELETE policies => anon cannot edit or delete comments.

-- ── Voting ───────────────────────────────────────────────────────────────────
-- A controlled increment. SECURITY DEFINER lets it bump score even though anon
-- has no UPDATE policy, and the delta is restricted to single up/down votes
-- (incl. flipping a vote, which is +/-2). Returns the new score.
create or replace function public.vote_comment(c_id bigint, delta integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_score integer;
begin
  if delta not in (-2, -1, 1, 2) then
    raise exception 'invalid delta %', delta;
  end if;

  update public.comments
     set score = score + delta
   where id = c_id
  returning score into new_score;

  if new_score is null then
    raise exception 'comment % not found', c_id;
  end if;

  return new_score;
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
grant select, insert on public.comments to anon, authenticated;
grant execute on function public.vote_comment(bigint, integer) to anon, authenticated;

-- ── Suggestion tier reactions ─────────────────────────────────────────────────
-- Each visitor — identified by an anonymous, client-generated voter_id kept in
-- their browser — may react to a suggestion with exactly one tier (S–F), and can
-- change or withdraw it. We store author + country so "See Votes" can show who
-- voted for which tier. One row per (comment, voter).
create table if not exists public.suggestion_reactions (
  id          bigint      generated always as identity primary key,
  comment_id  bigint      not null references public.comments(id) on delete cascade,
  voter_id    text        not null,
  tier        text        not null,
  author      text        not null default 'anon',
  country     text,
  created_at  timestamptz not null default now(),
  constraint reaction_tier_valid   check (tier in ('S', 'A', 'B', 'C', 'D', 'E', 'F')),
  constraint reaction_voter_len    check (char_length(voter_id) between 1 and 64),
  constraint reaction_author_len   check (char_length(author) <= 32),
  constraint reaction_country_len  check (country is null or char_length(country) <= 2),
  unique (comment_id, voter_id)
);

create index if not exists suggestion_reactions_comment_idx
  on public.suggestion_reactions (comment_id);

-- Like comments: anyone can read; all writes go through the functions below
-- (SECURITY DEFINER, so they bypass RLS the way vote_comment does) — anon gets
-- no direct insert/update/delete.
alter table public.suggestion_reactions enable row level security;

drop policy if exists "read reactions" on public.suggestion_reactions;
create policy "read reactions" on public.suggestion_reactions
  for select
  using (true);

-- Upsert the caller's reaction to a suggestion (replaces any prior tier).
create or replace function public.react_suggestion(
  c_id bigint, voter text, t text, a text, ctry text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if t not in ('S', 'A', 'B', 'C', 'D', 'E', 'F') then
    raise exception 'invalid tier %', t;
  end if;
  if not exists (select 1 from public.comments where id = c_id and kind = 'suggestion') then
    raise exception 'comment % is not a suggestion', c_id;
  end if;

  insert into public.suggestion_reactions (comment_id, voter_id, tier, author, country)
  values (
    c_id,
    left(voter, 64),
    t,
    left(coalesce(nullif(a, ''), 'anon'), 32),
    nullif(left(coalesce(ctry, ''), 2), '')
  )
  on conflict (comment_id, voter_id)
  do update set tier       = excluded.tier,
                author     = excluded.author,
                country    = excluded.country,
                created_at = now();
end;
$$;

-- Withdraw the caller's reaction.
create or replace function public.unreact_suggestion(c_id bigint, voter text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.suggestion_reactions
   where comment_id = c_id and voter_id = left(voter, 64);
end;
$$;

grant select on public.suggestion_reactions to anon, authenticated;
grant execute on function public.react_suggestion(bigint, text, text, text, text) to anon, authenticated;
grant execute on function public.unreact_suggestion(bigint, text) to anon, authenticated;

-- ── Push notifications ────────────────────────────────────────────────────────
-- Two pieces:
--   1. comments.device_id — the anonymous per-device id (see identity.js) of the
--      poster, so a reply can be routed back to the parent comment's author for a
--      "reply" notification. Not authenticated; same honor-system trust model as
--      the rest of the app.
--   2. push_subscriptions — one row per browser that opted in, holding the Web
--      Push endpoint/keys plus that device's preferences. The send-push Edge
--      Function (service role) reads these to decide who to notify.

alter table public.comments add column if not exists device_id text;
do $$ begin
  alter table public.comments
    add constraint device_id_len check (device_id is null or char_length(device_id) <= 64);
exception when duplicate_object then null;
end $$;

create table if not exists public.push_subscriptions (
  id              bigint      generated always as identity primary key,
  endpoint        text        not null unique,         -- the browser's push endpoint URL
  p256dh          text        not null,                -- client public key (for payload encryption)
  auth            text        not null,                -- client auth secret
  device_id       text,                                -- = the poster's voterId; for "replies to me"
  notify_daily    boolean     not null default true,   -- daily "new category" nudge
  notify_comments boolean     not null default true,   -- new-comment pings
  comment_mode    text        not null default 'all',  -- 'all' | 'replies'
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint comment_mode_valid check (comment_mode in ('all', 'replies')),
  constraint endpoint_len  check (char_length(endpoint) <= 1024),
  constraint device_id_len check (device_id is null or char_length(device_id) <= 64)
);

create index if not exists push_subscriptions_device_idx on public.push_subscriptions (device_id);

-- Per-device daily-reminder scheduling: the local hour the user chose (0–23),
-- their IANA timezone (so the send-time → local-time conversion is DST-correct),
-- and the last local date a daily reminder was sent (a once-per-day guard, since
-- the cron now runs hourly). daily_last_sent is written only by the Edge Function.
alter table public.push_subscriptions add column if not exists daily_hour integer not null default 9;
alter table public.push_subscriptions add column if not exists timezone text;
alter table public.push_subscriptions add column if not exists daily_last_sent text;
do $$ begin
  alter table public.push_subscriptions add constraint daily_hour_valid check (daily_hour between 0 and 23);
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.push_subscriptions add constraint timezone_len check (timezone is null or char_length(timezone) <= 64);
exception when duplicate_object then null;
end $$;

-- RLS on, with NO anon policies: the browser can't read or write the table
-- directly (endpoints/keys stay private). All writes go through the SECURITY
-- DEFINER functions below; the Edge Function reads via the service role, which
-- bypasses RLS.
alter table public.push_subscriptions enable row level security;

-- Create-or-update this device's subscription (keyed on endpoint). Re-called
-- whenever a preference toggle changes, so it doubles as "save my prefs".
-- daily_last_sent is intentionally NOT touched here — it's the Edge Function's
-- send guard, so changing the reminder hour never re-arms a same-day reminder.
--
-- The argument list grew (added p_daily_hour, p_timezone), so drop the prior
-- signature first to avoid leaving a stale overload behind on re-run.
drop function if exists public.upsert_push_subscription(text, text, text, text, boolean, boolean, text);
create or replace function public.upsert_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_device     text,
  p_daily      boolean,
  p_comments   boolean,
  p_mode       text,
  p_daily_hour integer,
  p_timezone   text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_mode not in ('all', 'replies') then
    raise exception 'invalid comment_mode %', p_mode;
  end if;

  insert into public.push_subscriptions
    (endpoint, p256dh, auth, device_id, notify_daily, notify_comments, comment_mode, daily_hour, timezone)
  values (
    left(p_endpoint, 1024),
    p_p256dh,
    p_auth,
    nullif(left(coalesce(p_device, ''), 64), ''),
    coalesce(p_daily, true),
    coalesce(p_comments, true),
    p_mode,
    least(23, greatest(0, coalesce(p_daily_hour, 9))),   -- clamp to a valid hour
    nullif(left(coalesce(p_timezone, ''), 64), '')
  )
  on conflict (endpoint) do update
    set p256dh          = excluded.p256dh,
        auth            = excluded.auth,
        device_id       = excluded.device_id,
        notify_daily    = excluded.notify_daily,
        notify_comments = excluded.notify_comments,
        comment_mode    = excluded.comment_mode,
        daily_hour      = excluded.daily_hour,
        timezone        = excluded.timezone,
        updated_at      = now();
end;
$$;

-- Remove this device's subscription (on disable / unsubscribe).
create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.push_subscriptions where endpoint = left(p_endpoint, 1024);
end;
$$;

grant execute on function public.upsert_push_subscription(text, text, text, text, boolean, boolean, text, integer, text) to anon, authenticated;
grant execute on function public.delete_push_subscription(text) to anon, authenticated;
