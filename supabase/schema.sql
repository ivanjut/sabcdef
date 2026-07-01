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

-- A soft-delete flag. When the author deletes a comment that has replies, we keep
-- the row so the thread stays intact, but scrub its content and set deleted =
-- true; the UI then renders a "[deleted]" tombstone. A comment with no replies is
-- hard-deleted instead (see delete_comment). Defaults false for existing rows.
alter table public.comments add column if not exists deleted boolean not null default false;

-- An edit flag. Set when the author rewrites their comment's body via
-- update_comment; the UI then shows a light-grey "(edited)" marker. Defaults
-- false for existing rows.
alter table public.comments add column if not exists edited boolean not null default false;

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

-- No UPDATE/DELETE policies => anon cannot edit or delete comments directly.
-- Removal goes through delete_comment below, and edits through update_comment —
-- both SECURITY DEFINER functions that first check the caller's device id.

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

-- ── Deleting your own comment ─────────────────────────────────────────────────
-- Anon has no direct DELETE/UPDATE policy, so removal goes through this SECURITY
-- DEFINER function. It acts ONLY when the caller's device id matches the one
-- stamped on the comment at post time (see identity.js) — i.e. a comment can be
-- removed only from the same device that posted it. Same honor-system trust model
-- as the rest of the app (the id is not a secret), but it keeps one device from
-- deleting another's posts.
--
-- A comment with replies is SOFT-deleted: the row stays (so the thread survives)
-- but its content is scrubbed and `deleted` is set, and the UI shows a "[deleted]"
-- tombstone. A comment with no replies is HARD-deleted outright.
--
-- Returns 'denied' (not the owner), 'tombstoned' (soft-deleted), or 'removed'
-- (hard-deleted) so the client can update its view without reloading. The return
-- type changed from an earlier boolean version, so drop that first.
drop function if exists public.delete_comment(bigint, text);
create or replace function public.delete_comment(c_id bigint, d_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  owns        boolean;
  has_replies boolean;
begin
  if d_id is null or char_length(d_id) = 0 then
    return 'denied';
  end if;

  select true into owns
    from public.comments
   where id = c_id
     and device_id is not null
     and device_id = left(d_id, 64);

  if not coalesce(owns, false) then
    return 'denied';
  end if;

  select exists (select 1 from public.comments where parent_id = c_id) into has_replies;

  if has_replies then
    update public.comments
       set body      = '[deleted]',
           author    = '[deleted]',
           country   = null,
           tier_list = null,
           device_id = null,
           deleted   = true
     where id = c_id;
    -- A deleted suggestion keeps no tier reactions behind its tombstone, and a
    -- deleted comment keeps no up/down vote attribution.
    delete from public.suggestion_reactions where comment_id = c_id;
    delete from public.comment_votes where comment_id = c_id;
    return 'tombstoned';
  end if;

  delete from public.comments where id = c_id;
  return 'removed';
end;
$$;

-- ── Editing your own comment ──────────────────────────────────────────────────
-- Like delete_comment, anon has no direct UPDATE policy, so edits go through this
-- SECURITY DEFINER function. It rewrites the body ONLY when the caller's device id
-- matches the one stamped on the (non-deleted) comment, and flags the row as
-- edited so the UI can show "(edited)". Returns 'denied' (not the owner, gone, or
-- already deleted) or 'ok'.
create or replace function public.update_comment(c_id bigint, d_id text, new_body text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  owns boolean;
begin
  if d_id is null or char_length(d_id) = 0 then
    return 'denied';
  end if;
  if new_body is null or char_length(btrim(new_body)) = 0 or char_length(new_body) > 4000 then
    raise exception 'invalid body';
  end if;

  select true into owns
    from public.comments
   where id = c_id
     and deleted = false
     and device_id is not null
     and device_id = left(d_id, 64);

  if not coalesce(owns, false) then
    return 'denied';
  end if;

  update public.comments
     set body   = new_body,
         edited = true
   where id = c_id;

  return 'ok';
end;
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
grant select, insert on public.comments to anon, authenticated;
grant execute on function public.vote_comment(bigint, integer) to anon, authenticated;
grant execute on function public.delete_comment(bigint, text) to anon, authenticated;
grant execute on function public.update_comment(bigint, text, text) to anon, authenticated;

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

-- ── Comment up/down vote attribution ──────────────────────────────────────────
-- comments.score is a fast net total, but it doesn't record WHO voted. This table
-- does: one row per (comment, voter), holding the direction (+1/-1) plus the
-- voter's author + country, so "who upvoted / downvoted" can be shown the way
-- Slack shows reactions. The aggregate score stays on comments.score (kept in sync
-- by cast_comment_vote below), so sorting/reads are unchanged; this table is only
-- consulted when someone opens the who-voted dialog. Same anonymous, client-
-- generated voter_id as suggestion_reactions. NOTE: only votes cast after this
-- table exists are recorded, so a comment's score may exceed the votes listed here
-- (older, pre-migration votes were never attributed).
create table if not exists public.comment_votes (
  id          bigint      generated always as identity primary key,
  comment_id  bigint      not null references public.comments(id) on delete cascade,
  voter_id    text        not null,
  dir         smallint    not null,                 -- +1 up, -1 down
  author      text        not null default 'anon',
  country     text,
  created_at  timestamptz not null default now(),
  constraint comment_vote_dir_valid    check (dir in (-1, 1)),
  constraint comment_vote_voter_len    check (char_length(voter_id) between 1 and 64),
  constraint comment_vote_author_len   check (char_length(author) <= 32),
  constraint comment_vote_country_len  check (country is null or char_length(country) <= 2),
  unique (comment_id, voter_id)
);

create index if not exists comment_votes_comment_idx
  on public.comment_votes (comment_id);

-- Read-only to clients; all writes go through the SECURITY DEFINER functions below
-- (anon has no direct insert/update/delete), same as suggestion_reactions.
alter table public.comment_votes enable row level security;

drop policy if exists "read comment_votes" on public.comment_votes;
create policy "read comment_votes" on public.comment_votes
  for select
  using (true);

-- Cast, change, or withdraw the caller's up/down vote on a comment, and keep the
-- cached comments.score in sync in the same call. new_dir is +1 (up), -1 (down),
-- or 0 (withdraw); the delta applied to score is computed from the caller's prior
-- vote, so the client can't inflate it. Returns the new score. Replaces the older
-- vote_comment(c_id, delta), which stays defined for backward-compat but is unused.
create or replace function public.cast_comment_vote(
  c_id bigint, voter text, new_dir integer, a text, ctry text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v         text := left(voter, 64);
  old_dir   integer;
  delta     integer;
  new_score integer;
begin
  if new_dir not in (-1, 0, 1) then
    raise exception 'invalid direction %', new_dir;
  end if;
  if v is null or char_length(v) = 0 then
    raise exception 'missing voter';
  end if;

  select dir into old_dir
    from public.comment_votes
   where comment_id = c_id and voter_id = v;
  old_dir := coalesce(old_dir, 0);

  delta := new_dir - old_dir;
  if delta = 0 then
    -- No change (e.g. re-casting the same direction) — return the score as-is.
    select score into new_score from public.comments where id = c_id;
    if new_score is null then
      raise exception 'comment % not found', c_id;
    end if;
    return new_score;
  end if;

  if new_dir = 0 then
    delete from public.comment_votes where comment_id = c_id and voter_id = v;
  else
    insert into public.comment_votes (comment_id, voter_id, dir, author, country)
    values (
      c_id, v, new_dir,
      left(coalesce(nullif(a, ''), 'anon'), 32),
      nullif(left(coalesce(ctry, ''), 2), '')
    )
    on conflict (comment_id, voter_id)
    do update set dir        = excluded.dir,
                  author     = excluded.author,
                  country    = excluded.country,
                  created_at = now();
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

-- Record the poster's implicit self-upvote (comments start at score 1) so the
-- author shows up in the who-voted dialog. Deliberately does NOT touch score — the
-- +1 is already baked into the default — and only the poster (matching device id)
-- may seed their own row, so it can't be used to fake someone else's vote.
create or replace function public.seed_comment_author_vote(
  c_id bigint, voter text, a text, ctry text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v text := left(voter, 64);
begin
  if v is null or char_length(v) = 0 then
    return;
  end if;
  if not exists (
    select 1 from public.comments where id = c_id and device_id = v
  ) then
    return;   -- not the poster (or comment gone) — no-op
  end if;

  insert into public.comment_votes (comment_id, voter_id, dir, author, country)
  values (
    c_id, v, 1,
    left(coalesce(nullif(a, ''), 'anon'), 32),
    nullif(left(coalesce(ctry, ''), 2), '')
  )
  on conflict (comment_id, voter_id) do nothing;
end;
$$;

grant select on public.comment_votes to anon, authenticated;
grant execute on function public.cast_comment_vote(bigint, text, integer, text, text) to anon, authenticated;
grant execute on function public.seed_comment_author_vote(bigint, text, text, text) to anon, authenticated;

-- ── Tier lists (the global feed + shareable links) ────────────────────────────
-- A player's whole board for a day, persisted via the "Submit" button (and when
-- they grab a share link) — independent of commenting. One row per (day, device);
-- re-submitting updates it in place. Every submission is stored with the profile's
-- `visibility`: the read policy exposes ONLY public rows, so the global feed shows
-- public submissions while private ones stay hidden from table reads. Each row
-- also gets an unguessable `share_id`; a list (public OR private) is viewable by
-- anyone holding its share link, via get_shared_tier_list below.
create table if not exists public.tier_lists (
  id          bigint      generated always as identity primary key,
  day         text        not null,                  -- YYYY-MM-DD the tier list belongs to
  device_id   text        not null,                  -- the anonymous per-device id (see identity.js)
  author      text        not null default 'anon',
  country     text,                                  -- author's ISO 3166-1 alpha-2 code (optional)
  tiers       text        not null,                  -- positional encoding of the board (see encodeTierList in app.js)
  visibility  text        not null default 'public', -- 'public' shows on the feed; 'private' is stored but hidden
  share_id    uuid        not null default gen_random_uuid(), -- stable, unguessable id for the share link
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tier_lists_tiers_len    check (char_length(tiers) between 1 and 64),
  constraint tier_lists_author_len   check (char_length(author) <= 32),
  constraint tier_lists_country_len  check (country is null or char_length(country) <= 2),
  constraint tier_lists_device_len   check (char_length(device_id) between 1 and 64),
  constraint tier_lists_visibility   check (visibility in ('public', 'private')),
  constraint tier_lists_share_uniq   unique (share_id),
  unique (day, device_id)
);

-- Backfill columns on tables created before these flags existed.
alter table public.tier_lists add column if not exists visibility text not null default 'public';
alter table public.tier_lists add column if not exists share_id uuid not null default gen_random_uuid();
do $$ begin
  alter table public.tier_lists
    add constraint tier_lists_visibility check (visibility in ('public', 'private'));
exception when duplicate_object then null;
end $$;
do $$ begin
  alter table public.tier_lists add constraint tier_lists_share_uniq unique (share_id);
-- Adding a UNIQUE constraint also creates an index of the same name, so a re-run
-- can trip on either the constraint (duplicate_object) or that index
-- (duplicate_table) already existing — tolerate both.
exception when duplicate_object or duplicate_table then null;
end $$;

create index if not exists tier_lists_day_idx on public.tier_lists (day);

-- Writes go through the SECURITY DEFINER functions below (anon gets no direct
-- insert/update/delete). The read policy exposes only public rows, so a private
-- submission is never selectable with the anon key — not merely filtered out of
-- the feed UI. Sharing a private list works through get_shared_tier_list, which
-- (as DEFINER) returns one row by its unguessable share_id regardless of the flag.
alter table public.tier_lists enable row level security;

drop policy if exists "read tier_lists" on public.tier_lists;
create policy "read tier_lists" on public.tier_lists
  for select
  using (visibility = 'public');

-- Publish (or update) the caller's tier list for a day, at the given visibility;
-- returns the row's stable share_id (created once, preserved across re-submits).
-- Drop prior overloads first (the arg list and return type changed across
-- versions) so create-or-replace doesn't choke on a re-run.
drop function if exists public.upsert_tier_list(text, text, text, text, text);
drop function if exists public.upsert_tier_list(text, text, text, text, text, text);
create or replace function public.upsert_tier_list(
  p_day text, p_device text, p_tiers text, p_author text, p_country text, p_visibility text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share_id uuid;
begin
  if p_tiers is null or char_length(p_tiers) < 1 or char_length(p_tiers) > 64 then
    raise exception 'invalid tiers %', p_tiers;
  end if;
  if p_device is null or char_length(p_device) < 1 then
    raise exception 'missing device';
  end if;
  if coalesce(p_visibility, 'public') not in ('public', 'private') then
    raise exception 'invalid visibility %', p_visibility;
  end if;

  insert into public.tier_lists (day, device_id, author, country, tiers, visibility)
  values (
    p_day,
    left(p_device, 64),
    left(coalesce(nullif(p_author, ''), 'anon'), 32),
    nullif(left(coalesce(p_country, ''), 2), ''),
    left(p_tiers, 64),
    coalesce(p_visibility, 'public')
  )
  on conflict (day, device_id)
  do update set tiers      = excluded.tiers,
                author     = excluded.author,
                country    = excluded.country,
                visibility = excluded.visibility,
                updated_at = now()
  returning share_id into v_share_id;

  return v_share_id;
end;
$$;

-- Fetch one tier list by its share_id, regardless of visibility — the read path
-- for a shareable link. Returns no rows for an unknown id.
create or replace function public.get_shared_tier_list(p_share_id uuid)
returns table (day text, author text, country text, tiers text, visibility text, updated_at timestamptz)
language sql
security definer
set search_path = public
stable
as $$
  select day, author, country, tiers, visibility, updated_at
    from public.tier_lists
   where share_id = p_share_id
   limit 1;
$$;

grant select on public.tier_lists to anon, authenticated;
grant execute on function public.upsert_tier_list(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.get_shared_tier_list(uuid) to anon, authenticated;

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

-- ── Categories (DB mirror of the served calendar) ─────────────────────────────
-- The client loads each day's category + items from static JSON
-- (public/categories/*.json, generated from scripts/calendar.txt); these tables
-- mirror that same data into the DB so aggregates (daily_averages) can be derived
-- WITH item identity rather than bare positions. Seed/refresh them with
-- supabase/categories-seed.sql, generated from the served JSON by
-- scripts/generate-category-seed.mjs. Read-only to clients; written only by that
-- seed (run as a privileged role). The client keeps reading the JSON, so the core
-- game stays static/offline — these tables are for server-side derivation only.
create table if not exists public.categories (
  day         text primary key,        -- YYYY-MM-DD (a TierDrop day)
  name        text not null,
  theme       text,
  special_day text
);

-- One row per item per day. `position` is the 0-based index in the day's item
-- list and MUST match the order boards are encoded in (tier_lists.tiers) — a
-- stored board's nth character is the item at position n. A day's item order must
-- stay fixed once boards exist for it.
create table if not exists public.category_items (
  day      text    not null references public.categories(day) on delete cascade,
  position integer not null,
  item_id  text    not null,           -- stable slug (e.g. 'mexican')
  name     text    not null,
  emoji    text,
  primary key (day, position),
  unique (day, item_id)
);

alter table public.categories enable row level security;
alter table public.category_items enable row level security;
drop policy if exists "read categories" on public.categories;
drop policy if exists "read category_items" on public.category_items;
create policy "read categories" on public.categories for select using (true);
create policy "read category_items" on public.category_items for select using (true);
grant select on public.categories to anon, authenticated;
grant select on public.category_items to anon, authenticated;

-- ── Daily global averages (permanent record) ──────────────────────────────────
-- A permanent, per-day snapshot of the group average across everyone's PUBLIC
-- tier lists — the same numbers the "Yesterday's results" screen computes live,
-- but persisted so the history survives. One row per day.
--
-- `items` is a JSON array, one entry per ranked item, joined to category_items so
-- it is self-describing:
--   { "pos": <0-based position>, "item_id": <slug>, "name": <item name>,
--     "mean": <avg tier 0=S…6=F>, "std": <population std>,
--     "n": <how many placed this item> }
-- (item_id/name are null for a day whose category_items haven't been seeded yet.)
-- The row's `n` is the number of public tier lists that day.
create table if not exists public.daily_averages (
  day         text        primary key,             -- YYYY-MM-DD (a TierDrop day)
  n           integer     not null,                -- public tier lists averaged
  items       jsonb       not null default '[]',   -- per-position stats (see above)
  computed_at timestamptz not null default now()
);

-- Aggregate, non-sensitive data derived from already-public boards: world-readable.
-- Writes happen only through snapshot_daily_averages (SECURITY DEFINER) — anon has
-- no insert/update/delete policy.
alter table public.daily_averages enable row level security;
drop policy if exists "read daily_averages" on public.daily_averages;
create policy "read daily_averages" on public.daily_averages
  for select
  using (true);

-- Compute and upsert one day's averages from its PUBLIC submissions. Mirrors the
-- client's tierStats: map each placed tier letter S…F to 0…6, skip unplaced
-- positions ('-'), average per position, population std. Idempotent (upserts by
-- day); deletes the row and returns 0 when the day has no public boards. Returns
-- the number of public tier lists averaged.
create or replace function public.snapshot_daily_averages(p_day text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total_n    integer;
  items_json jsonb;
begin
  select count(*) into total_n
  from public.tier_lists
  where day = p_day
    and visibility = 'public'
    and tiers ~ '[SABCDEF]';          -- placed at least one ranked item

  if coalesce(total_n, 0) = 0 then
    delete from public.daily_averages where day = p_day;   -- keep the table truthful
    return 0;
  end if;

  with pub as (
    select tiers
    from public.tier_lists
    where day = p_day
      and visibility = 'public'
      and tiers ~ '[SABCDEF]'
  ),
  cells as (
    select g.pos - 1 as pos,                  -- 0-based, matches category_items.position
           position(substr(t.tiers, g.pos, 1) in 'SABCDEF') - 1 as idx
    from pub t
    cross join lateral generate_series(1, char_length(t.tiers)) as g(pos)
  ),
  placed as (
    select pos, idx from cells where idx >= 0          -- drop '-' (unplaced)
  ),
  per_pos as (
    select pos,
           avg(idx)::numeric                  as mean,
           coalesce(stddev_pop(idx), 0)::numeric as std,
           count(*)::integer                  as n
    from placed
    group by pos
  )
  -- Join to category_items so each entry is self-describing (item_id + name).
  -- LEFT JOIN so averages still compute (id/name null) if a day isn't seeded yet.
  select jsonb_agg(
           jsonb_build_object(
             'pos',     pp.pos,
             'item_id', ci.item_id,
             'name',    ci.name,
             'mean',    round(pp.mean, 6),
             'std',     round(pp.std, 6),
             'n',       pp.n
           )
           order by pp.pos
         )
  into items_json
  from per_pos pp
  left join public.category_items ci
    on ci.day = p_day and ci.position = pp.pos;

  insert into public.daily_averages (day, n, items, computed_at)
  values (p_day, total_n, coalesce(items_json, '[]'::jsonb), now())
  on conflict (day) do update
    set n           = excluded.n,
        items       = excluded.items,
        computed_at = excluded.computed_at;

  return total_n;
end;
$$;

grant select on public.daily_averages to anon, authenticated;
