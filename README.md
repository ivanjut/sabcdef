# sabcdef

A new category every day that you rank into tiers (S → F), with an open
Reddit-style forum to debate the rankings. Mobile-first, works on any screen.

**Live:** https://ivanjut.github.io/sabcdef/

## Stack

- **Static frontend** — vanilla HTML/CSS/JS, no build step (`public/`)
- **SortableJS** (CDN) — touch-friendly drag-and-drop for tiering
- **Supabase** — hosted Postgres + browser SDK for the shared comment forum
- **GitHub Pages** — hosting, deployed by GitHub Actions (`.github/workflows/deploy.yml`)

There is no server to run: the daily category is computed in the browser and the
forum talks to Supabase directly.

## Run locally

```bash
npm start          # serves public/ at http://localhost:3000 (zero dependencies)
# npm run dev      # same, restarts on file changes
```

The tier list, daily category, and theme work immediately. The forum needs
Supabase configured (below); until then it shows an "offline" notice.

## Configure the forum (Supabase)

1. Create a free project at [supabase.com](https://supabase.com).
2. In the project's **SQL Editor**, run [`supabase/schema.sql`](supabase/schema.sql)
   (creates the `comments` table, RLS policies, and the `vote_comment` function).
3. In **Project Settings → API**, copy the **Project URL** and the **anon public**
   key into [`public/config.js`](public/config.js).
4. Commit and push — the deploy workflow publishes the change.

The anon key is meant to live in the browser; Row Level Security (in the schema)
is what restricts access. Never put the `service_role` key in `config.js`.

## Deploy (GitHub Pages)

Already wired up: every push to `main` runs the **Deploy to GitHub Pages**
workflow, which publishes `public/`. Pages is set to the "GitHub Actions" source.

To point Pages at a different folder or repo, edit the `path:` in
`.github/workflows/deploy.yml`.

## How it works

- **Daily category** — chosen deterministically from the date (whole days since
  the epoch, modulo the list in `public/categories.js`), so everyone sees the
  same category each day. Comments are keyed per day.
- **Tier rankings** — saved to `localStorage` per day (private to each device).
  "Copy ranking" exports a shareable text version.
- **Forum** — threaded comments with up/down votes, sortable by Top or New.
  No accounts: an optional display name is stored locally. Votes are tracked
  client-side to limit double-voting on the same device.

## What this version deliberately skips

- No accounts/auth — display names are unverified and votes are device-local.
  Add Supabase Auth + a per-user votes table before relying on the counts.
- Items are emoji-based — swap `emoji` for an `img` URL in
  `public/categories.js`; the tier logic doesn't change.
- Rankings aren't aggregated server-side yet (no "community average" tier list).

## Layout

```
public/
  index.html       Markup
  styles.css       Mobile-first styling, light/dark themes
  app.js           Tier list + forum client logic
  categories.js    The rotating pool of daily categories
  config.js        Supabase URL + anon key (you fill these in)
  supabase.js      Creates the Supabase client
supabase/
  schema.sql       Forum table, RLS policies, vote function
serve.js           Zero-dependency static server for local dev
.github/workflows/
  deploy.yml       Builds & deploys public/ to GitHub Pages
```
