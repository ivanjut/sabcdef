# sabcdef

A new category every day that you rank into tiers (S → F), with an open
Reddit-style forum to debate the rankings. Mobile-first, works on any screen.

## Stack

- **Node + Express** — tiny API + static file server (`server.js`)
- **better-sqlite3** — single-file database for the comment forum (`db.js`)
- **Vanilla HTML/CSS/JS** — no build step (`public/`)
- **SortableJS** (CDN) — touch-friendly drag-and-drop for tiering

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

`npm run dev` restarts the server on file changes.

## How it works

- **Daily category** — chosen deterministically from the date (whole days since
  the epoch, modulo the category list in `data/categories.js`), so everyone sees
  the same category each day and rotates predictably. Comments are keyed per day.
- **Tier rankings** — each visitor's placements are saved to `localStorage`
  (per day), so they're private and persist on that device. "Copy ranking"
  exports a shareable text version.
- **Forum** — threaded comments with up/down votes, sortable by Top or New.
  No accounts in v1: pick an optional display name (also stored locally). Votes
  are tracked client-side to prevent double-voting on the same device.

## What v1 deliberately skips

- No accounts/auth — display names are unverified and votes are device-local
  (clearing storage lets you vote again). Fine for a demo; add real auth +
  server-side vote records before exposing it publicly.
- Items are emoji-based — swap `emoji` for an `img` URL in `data/categories.js`
  to use real images; the tier logic doesn't change.
- Rankings aren't aggregated server-side yet (no "community average" tier list).

## Layout

```
server.js            Express app, API routes, daily-category logic
db.js                SQLite schema + comment queries
data/categories.js   The rotating pool of daily categories
public/
  index.html         Markup
  styles.css         Mobile-first styling
  app.js             Tier list + forum client logic
```
