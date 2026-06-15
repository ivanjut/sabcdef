-- sabcdef forum schema for Supabase.
-- Run this once in your project's SQL Editor (Dashboard → SQL → New query).
-- It is safe to re-run.

-- ── Table ───────────────────────────────────────────────────────────────────
create table if not exists public.comments (
  id          bigint generated always as identity primary key,
  day         text        not null,              -- YYYY-MM-DD the comment belongs to
  parent_id   bigint      references public.comments(id) on delete cascade,
  author      text        not null default 'anon',
  body        text        not null,
  score       integer     not null default 1,    -- starts at 1 (author's implicit upvote)
  created_at  timestamptz not null default now(),
  constraint body_len   check (char_length(body) between 1 and 4000),
  constraint author_len check (char_length(author) <= 32)
);

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
