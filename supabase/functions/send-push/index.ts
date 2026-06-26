// Supabase Edge Function: send-push
//
// Sends Web Push notifications to the devices in public.push_subscriptions.
// It's invoked two ways (see supabase/notifications-setup.sql):
//
//   • Daily nudge   — pg_cron POSTs { "type": "daily" } once a day.
//   • New comment   — a Database Webhook on `comments` INSERT POSTs the row as
//                     { "type": "INSERT", "table": "comments", "record": {...} }.
//
// Recipient logic for a new comment by device D (author):
//   – Reply ping: if it's a reply, the parent comment's author device gets
//     "<author> replied to you" (as long as that device opted into comments).
//     This is what "Only replies to me" subscribers receive.
//   – Broadcast:  every "all"-mode subscriber (except D and the parent author,
//     who already got the more specific reply ping) gets "New comment…".
//
// Auth: callers must send the shared secret in `x-webhook-secret`. Deploy with
// `--no-verify-jwt` so the secret (not a Supabase JWT) is the gate:
//   supabase functions deploy send-push --no-verify-jwt

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const APP_URL = Deno.env.get("APP_URL") ?? "/";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// Service-role client bypasses RLS so it can read every subscription.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

interface Row {
  endpoint: string;
  p256dh: string;
  auth: string;
  device_id: string | null;
}
interface Stats {
  sent: number;
  failed: number;
  pruned: number;
}

const SELECT = "endpoint,p256dh,auth,device_id";

// Notifications name the day's category by reading the SAME calendar the client
// reads — the per-day config files the site serves under /categories/ (see
// public/categories.js and categoryForDay() in public/app.js). Reading the live
// calendar means there's no second, hand-maintained list of names to drift out
// of sync (which is exactly what used to mislabel notifications).
const CATEGORIES_BASE = `${APP_URL.replace(/\/+$/, "")}/categories`;
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

// Per-instance caches: a warm function reuses these across invocations so it
// doesn't refetch the manifest/config (or re-resolve a day) every time.
let manifestFilesPromise: Promise<string[]> | null = null;
const configCache = new Map<string, Promise<{ date: string; name: string } | null>>();
const dayNameCache = new Map<string, string>();

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

// The config filenames in date order (mirrors the client's CATEGORIES array).
function categoryFiles(): Promise<string[]> {
  if (!manifestFilesPromise) {
    manifestFilesPromise = fetchJson(`${CATEGORIES_BASE}/index.json`)
      .then((m) => (Array.isArray(m) ? m : m?.files ?? []))
      .catch((err) => {
        manifestFilesPromise = null; // allow a retry after a transient failure
        throw err;
      });
  }
  return manifestFilesPromise;
}

function loadConfig(file: string): Promise<{ date: string; name: string } | null> {
  let p = configCache.get(file);
  if (!p) {
    p = fetchJson(`${CATEGORIES_BASE}/${file}`)
      .then((c) => ({ date: c.date as string, name: c.name as string }))
      .catch(() => null);
    configCache.set(file, p);
  }
  return p;
}

// The category name shown for a YYYY-MM-DD day, resolved exactly like the app's
// categoryForDay(): an exact date match in the calendar, else a deterministic
// rotation over the (date-ordered) list (rotationForDay()). Only if the calendar
// can't be reached do we return a generic label — so a notification never names
// the wrong category.
async function categoryNameForDay(day: string): Promise<string> {
  if (!day) return "today's category";
  const cached = dayNameCache.get(day);
  if (cached) return cached;

  let name = "today's category";
  try {
    const files = await categoryFiles();
    if (files.length) {
      // Primary: the file whose name encodes this date (dd-monthname-year_*),
      // confirmed against its `date` field so a filename change can't mislabel.
      const [y, m, d] = day.split("-");
      const prefix = `${d}-${MONTHS[Number(m) - 1]}-${y}_`;
      const named = files.find((f) => f.startsWith(prefix));
      let cfg = named ? await loadConfig(named) : null;

      // Fallback for days outside the calendar: rotate over the list by
      // epoch-days, identical to rotationForDay() in app.js.
      if (!cfg || cfg.date !== day) {
        const epochDays = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
        if (Number.isFinite(epochDays)) {
          const idx = ((epochDays % files.length) + files.length) % files.length;
          cfg = await loadConfig(files[idx]);
        }
      }

      if (cfg?.name) {
        name = cfg.name;
        dayNameCache.set(day, name); // cache only a real resolution, not the fallback
      }
    }
  } catch (err) {
    console.error(`categoryNameForDay(${day}) failed:`, err);
  }
  return name;
}

// The category rotates at this UTC hour worldwide — keep in sync with
// CATEGORY_SWITCH_UTC_HOUR in public/app.js.
const CATEGORY_SWITCH_UTC_HOUR = 5;

// The global "TierDrop day" (YYYY-MM-DD) at an instant, computed the same way the
// client does, so the daily reminder can name the currently-live category.
function currentGlobalDay(now: Date): string {
  return new Date(now.getTime() - CATEGORY_SWITCH_UTC_HOUR * 3_600_000).toISOString().slice(0, 10);
}

// The wall-clock hour (0–23) and calendar date (YYYY-MM-DD) in an IANA timezone
// right now — DST-correct. Falls back to UTC for a blank/invalid zone.
function localHourAndDate(now: Date, tz: string): { hour: number; date: string } {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(now)
    );
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    return { hour: hour % 24, date }; // normalize a "24" some engines emit at midnight
  } catch {
    return { hour: now.getUTCHours(), date: now.toISOString().slice(0, 10) };
  }
}

function truncate(text: string, max = 120): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

// Notification tap targets. These are RELATIVE to the app's scope ("./…"), never
// absolute (https://…): on an installed iOS PWA, opening/navigating to an
// absolute URL kicks the user out into Safari, while an in-scope relative URL
// stays inside the app. The service worker (public/sw.js) resolves and routes
// these; the app (public/app.js) reads ?comment=/?thread= to scroll to the post.
const HOME_URL = "./";

// Deep link to a specific comment/reply. `thread` is the comments.day value
// (e.g. "2026-06-26" or "2026-06-25#results"); URLSearchParams encodes its "#"
// as %23 so it stays in the query, not a fragment.
function commentUrl(commentId: number, thread: string): string {
  const qs = new URLSearchParams({ comment: String(commentId), thread: thread ?? "" });
  return `./?${qs.toString()}`;
}

// Send one notification to a set of subscriptions; prune any that are gone.
async function deliver(rows: Row[], notification: Record<string, unknown>): Promise<Stats> {
  if (!rows.length) return { sent: 0, failed: 0, pruned: 0 };
  const payload = JSON.stringify(notification);

  const results = await Promise.allSettled(
    rows.map((r) =>
      webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload)
    )
  );

  const dead: string[] = [];
  results.forEach((res, i) => {
    if (res.status === "rejected") {
      const code = (res.reason as { statusCode?: number })?.statusCode;
      // 404 (gone) / 410 (expired) → the subscription is dead; drop it.
      if (code === 404 || code === 410) dead.push(rows[i].endpoint);
    }
  });
  if (dead.length) await admin.from("push_subscriptions").delete().in("endpoint", dead);

  const sent = results.filter((r) => r.status === "fulfilled").length;
  return { sent, failed: results.length - sent, pruned: dead.length };
}

interface DailyRow extends Row {
  daily_hour: number;
  timezone: string | null;
  daily_last_sent: string | null;
}

const DAILY_SELECT = "endpoint,p256dh,auth,device_id,daily_hour,timezone,daily_last_sent";

// Invoked hourly by cron. Sends the daily reminder only to subscriptions whose
// local time has just reached their chosen hour and that haven't been reminded
// yet today (in their own local date) — so each device gets exactly one daily
// push, at its own local time.
async function handleDaily(body: Record<string, unknown>): Promise<Stats> {
  const { data, error } = await admin
    .from("push_subscriptions")
    .select(DAILY_SELECT)
    .eq("notify_daily", true);
  if (error) throw error;

  const now = new Date();
  const subs = (data ?? []) as DailyRow[];

  const due: { row: DailyRow; localDate: string }[] = [];
  for (const s of subs) {
    const { hour, date } = localHourAndDate(now, s.timezone || "UTC");
    if (hour === (s.daily_hour ?? 9) && s.daily_last_sent !== date) {
      due.push({ row: s, localDate: date });
    }
  }
  if (!due.length) return { sent: 0, failed: 0, pruned: 0 };

  const stats = await deliver(
    due.map((d) => d.row),
    {
      title: (body.title as string) ?? "",
      body: (body.body as string) ?? "Today's category just dropped!",
      // The daily nudge just opens the app's home (today's category).
      url: (body.url as string) ?? HOME_URL,
      tag: (body.tag as string) ?? `daily-${currentGlobalDay(now)}`
    }
  );

  // Mark each reminded device for its local date, grouped so one UPDATE covers
  // each date. This is the once-per-day guard against the hourly cron.
  const byDate = new Map<string, string[]>();
  for (const d of due) {
    const list = byDate.get(d.localDate) ?? [];
    list.push(d.row.endpoint);
    byDate.set(d.localDate, list);
  }
  for (const [date, endpoints] of byDate) {
    await admin.from("push_subscriptions").update({ daily_last_sent: date }).in("endpoint", endpoints);
  }

  return stats;
}

interface CommentRecord {
  id: number;
  parent_id: number | null;
  kind: string;
  body: string;
  author: string;
  device_id: string | null;
  day: string;
}

async function handleComment(record: CommentRecord): Promise<Stats> {
  if (!record) return { sent: 0, failed: 0, pruned: 0 };

  const authorDevice = record.device_id ?? null;
  const isSuggestion = record.kind === "suggestion";
  const snippet = truncate(record.body ?? "");
  const author = record.author || "Someone";

  // 1) Reply ping to the parent comment's author device.
  let parentDevice: string | null = null;
  let replyRows: Row[] = [];
  if (record.parent_id != null) {
    const { data: parent } = await admin
      .from("comments")
      .select("device_id")
      .eq("id", record.parent_id)
      .maybeSingle();
    parentDevice = parent?.device_id ?? null;
    if (parentDevice && parentDevice !== authorDevice) {
      const { data } = await admin
        .from("push_subscriptions")
        .select(SELECT)
        .eq("device_id", parentDevice)
        .eq("notify_comments", true);
      replyRows = (data ?? []) as Row[];
    }
  }

  // 2) Broadcast to "all"-mode subscribers, minus the author and parent author.
  const { data: allData } = await admin
    .from("push_subscriptions")
    .select(SELECT)
    .eq("notify_comments", true)
    .eq("comment_mode", "all");
  const excluded = new Set([authorDevice, parentDevice].filter(Boolean) as string[]);
  const broadcastRows = ((allData ?? []) as Row[]).filter((r) => !r.device_id || !excluded.has(r.device_id));

  const total: Stats = { sent: 0, failed: 0, pruned: 0 };
  const add = (s: Stats) => {
    total.sent += s.sent;
    total.failed += s.failed;
    total.pruned += s.pruned;
  };

  if (replyRows.length) {
    add(
      await deliver(replyRows, {
        title: `${author} replied to you`,
        body: snippet,
        // Open straight to the new reply.
        url: commentUrl(record.id, record.day ?? ""),
        tag: `reply-${record.parent_id}`
      })
    );
  }
  if (broadcastRows.length) {
    // The "yesterday's results" thread stores its day as "<YYYY-MM-DD>#results";
    // resolve the category against the real date so the title still names it, and
    // give that thread its own wording so it reads distinctly from the live one.
    const isResults = (record.day ?? "").includes("#results");
    const dayName = await categoryNameForDay((record.day ?? "").split("#")[0]);
    const title = isResults
      ? `New comment on yesterday's ${dayName} results`
      : isSuggestion
        ? `New suggestion for ${dayName}`
        : `New comment for ${dayName}`;
    add(
      await deliver(broadcastRows, {
        title,
        body: `${author}: ${snippet}`,
        // Open straight to the new comment in its thread.
        url: commentUrl(record.id, record.day ?? ""),
        tag: `day-${record.day ?? "today"}`
      })
    );
  }
  return total;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Shared-secret gate. Skipped only when no secret is configured (local dev).
  if (WEBHOOK_SECRET && req.headers.get("x-webhook-secret") !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* an empty body is allowed (treated as a daily trigger below if typed) */
  }

  try {
    let result: Stats;
    if (body.type === "daily") {
      result = await handleDaily(body);
    } else if (body.record && (body.table === "comments" || body.type === "comment")) {
      result = await handleComment(body.record as CommentRecord);
    } else {
      return new Response(JSON.stringify({ error: "Unrecognized payload" }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, ...result }), {
      headers: { "content-type": "application/json" }
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });
  }
});
