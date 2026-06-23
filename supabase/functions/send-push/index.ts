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

function truncate(text: string, max = 120): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
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

async function handleDaily(body: Record<string, unknown>): Promise<Stats> {
  const { data, error } = await admin.from("push_subscriptions").select(SELECT).eq("notify_daily", true);
  if (error) throw error;
  return deliver((data ?? []) as Row[], {
    title: (body.title as string) ?? "TierDrop",
    body: (body.body as string) ?? "Today's category just dropped — open the app and rank it.",
    url: (body.url as string) ?? APP_URL,
    tag: (body.tag as string) ?? "daily"
  });
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
        url: APP_URL,
        tag: `reply-${record.parent_id}`
      })
    );
  }
  if (broadcastRows.length) {
    add(
      await deliver(broadcastRows, {
        title: isSuggestion ? "New suggestion on TierDrop" : "New comment on TierDrop",
        body: `${author}: ${snippet}`,
        url: APP_URL,
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
