# sabcdef

A new category every day that you rank into tiers (S → F), with an open
Reddit-style forum to debate the tier lists. Mobile-first, works on any screen.

**Live:** https://ivanjut.github.io/sabcdef/

## Stack

- **Static frontend** — vanilla HTML/CSS/JS, no build step (`public/`)
- **SortableJS** (CDN) — touch-friendly drag-and-drop for tiering
- **Supabase** — hosted Postgres + browser SDK for the shared comment forum, plus
  an Edge Function (`supabase/functions/send-push`) that sends push notifications
- **PWA** — installable to the home screen (manifest + service worker), with Web
  Push for the daily category and new comments
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

## Install as an app + notifications (PWA)

TierDrop is a Progressive Web App: visitors can **Add to Home Screen** on Android
and iOS and run it like a native app. Install works as soon as the manifest +
service worker ship — no extra setup.

**Notifications** (a daily nudge when the category drops, and pings for new
comments) need three one-time pieces of setup. Until they're done, everything
else works and the header bell stays hidden.

1. **Generate a VAPID key pair** (identifies your push server to browsers):

   ```bash
   npx web-push generate-vapid-keys
   ```

2. **Publish the public key.** Paste it into `public/config.js` as
   `VAPID_PUBLIC_KEY`. (Like the Supabase anon key, this one is meant to ship in
   the browser.)

3. **Apply the schema + deploy the sender.** Re-run [`supabase/schema.sql`](supabase/schema.sql)
   (it adds the `push_subscriptions` table and `comments.device_id`), then deploy
   the Edge Function and set its secrets:

   ```bash
   supabase functions deploy send-push --no-verify-jwt
   supabase secrets set \
     VAPID_PUBLIC_KEY=<public>  VAPID_PRIVATE_KEY=<private> \
     VAPID_SUBJECT=mailto:you@example.com \
     WEBHOOK_SECRET=<a-long-random-string> \
     APP_URL=https://ivanjut.github.io/sabcdef/
   ```

   Finally, edit the two placeholders in
   [`supabase/notifications-setup.sql`](supabase/notifications-setup.sql) and run
   it — that schedules the daily push (`pg_cron`) and the new-comment trigger
   (`pg_net`).

**How recipients are chosen.** Each device opts in from the bell menu and picks,
on-device, between **All new comments** and **Only replies to me**; the choice is
mirrored onto the server subscription so the sender can honor it. A reply always
pings the parent comment's author; "all"-mode subscribers additionally get every
new comment (except their own). Identity is the same anonymous per-device id the
forum already uses (`identity.js`) — no accounts.

**Daily reminder time.** Each device also picks the **local hour** it wants the
daily reminder. The cron runs *hourly* and the `send-push` function notifies only
the devices whose local time has just reached their chosen hour (and that haven't
been reminded yet that day). The device's IANA timezone is stored with the
subscription so the conversion is DST-correct. Because of this, the daily cron
**must stay hourly** — a once-a-day schedule would only ever match one timezone.

**iOS note.** Web Push on iPhone/iPad only works for an *installed* PWA (iOS 16.4+).
The bell explains this: users must Add to Home Screen and open it from there first.
If iOS push reliability matters, the same `public/` can later be wrapped with
Capacitor for native APNs without changing the app code.

## Deploy (GitHub Pages)

Already wired up: every push to `main` runs the **Deploy to GitHub Pages**
workflow, which publishes `public/`. Pages is set to the "GitHub Actions" source.

To point Pages at a different folder or repo, edit the `path:` in
`.github/workflows/deploy.yml`.

## How it works

- **Daily category** — chosen deterministically from the date (whole days since
  the epoch, modulo the list in `public/categories.js`), so everyone sees the
  same category each day. The day rolls over at a fixed UTC moment
  (`CATEGORY_SWITCH_UTC_HOUR` in `app.js`, default 05:00 UTC) rather than each
  visitor's local midnight, so the whole world shares one category and one
  comment thread at any instant. Comments are keyed per (global) day.
- **Tier lists** — saved to `localStorage` per day (private to each device).
  "Copy tier list" exports a shareable text version.
- **Forum** — threaded comments with up/down votes, sortable by Top or New.
  No accounts: an optional display name is stored locally. Votes are tracked
  client-side to limit double-voting on the same device.

## What this version deliberately skips

- No accounts/auth — display names are unverified and votes are device-local.
  Add Supabase Auth + a per-user votes table before relying on the counts.
- Items are emoji-based — swap `emoji` for an `img` URL in
  `public/categories.js`; the tier logic doesn't change.
- Tier lists aren't aggregated server-side yet (no "community average" tier list).

## Layout

```
public/
  index.html             Markup
  styles.css             Mobile-first styling, light/dark themes
  app.js                 Tier list + forum client logic
  categories.js          The rotating pool of daily categories
  config.js              Supabase URL + anon key + VAPID public key (you fill these in)
  supabase.js            Creates the Supabase client
  identity.js            Anonymous per-device id (shared by forum + push)
  push.js                Service-worker registration + notification opt-in UI
  sw.js                  Service worker: receives push, shows notifications
  manifest.webmanifest   PWA manifest (installable)
  icon-*.png             App / maskable / Apple-touch icons
supabase/
  schema.sql             Forum + push_subscriptions tables, RLS, RPC functions
  notifications-setup.sql  pg_cron daily job + new-comment trigger (placeholders)
  functions/send-push/   Edge Function that sends the Web Push messages
serve.js                 Zero-dependency static server for local dev
.github/workflows/
  deploy.yml             Builds & deploys public/ to GitHub Pages
```
