// Web Push client. Handles the service worker registration, the permission +
// subscription dance, and the Notifications dialog (master switch, daily/new-
// comment toggles, and the "all comments vs. only replies to me" choice).
//
// Preferences are saved on-device (localStorage) so the dialog reflects the
// user's choice instantly, AND mirrored onto the server subscription row — the
// send-push Edge Function needs them there to decide who to notify. Toggling a
// preference while subscribed re-syncs the row; it never re-prompts.
//
// The subscription itself (does this device want pushes at all) is owned by the
// browser's PushManager, so that's the source of truth for the master switch.

import { supabase, isConfigured } from "./supabase.js";
import { VAPID_PUBLIC_KEY } from "./config.js";
import { getDeviceId } from "./identity.js";

const $ = (sel, root = document) => root.querySelector(sel);

const prefsKey = "sabcdef:notify"; // { daily, comments, mode, dailyHour } — saved on device
const DEFAULT_PREFS = { daily: true, comments: true, mode: "all", dailyHour: 9 };

const vapidConfigured = Boolean(VAPID_PUBLIC_KEY) && !VAPID_PUBLIC_KEY.includes("YOUR-");

let swReg = null; // the active ServiceWorkerRegistration

// ---- Preference storage (on device) ---------------------------------------

function getPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(prefsKey)) || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function setPrefs(prefs) {
  try {
    localStorage.setItem(prefsKey, JSON.stringify(prefs));
  } catch {
    /* private mode / quota — ignore */
  }
}

// ---- Capability detection --------------------------------------------------

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIos() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || /iP(hone|ad|od)/.test(navigator.platform || "");
}

function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true
  );
}

// This device's IANA timezone (e.g. "America/New_York"), sent with the
// subscription so the server can convert the chosen local hour to a real send
// time, DST-correct. Falls back to UTC if the browser won't say.
function getTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// "9:00 AM" style label for an hour 0–23.
function hourLabel(h) {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${period}`;
}

// ---- Subscription plumbing -------------------------------------------------

// VAPID public keys are base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentSubscription() {
  if (!swReg) return null;
  return swReg.pushManager.getSubscription();
}

// Push the subscription + prefs to Supabase (upsert keyed on endpoint).
async function syncSubscription(sub, prefs) {
  const j = sub.toJSON();
  const { error } = await supabase.rpc("upsert_push_subscription", {
    p_endpoint: j.endpoint,
    p_p256dh: j.keys.p256dh,
    p_auth: j.keys.auth,
    p_device: getDeviceId(),
    p_daily: prefs.daily,
    p_comments: prefs.comments,
    p_mode: prefs.mode,
    p_daily_hour: prefs.dailyHour,
    p_timezone: getTimeZone()
  });
  if (error) throw new Error(error.message);
}

async function subscribe() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    const err = new Error(permission === "denied" ? "denied" : "dismissed");
    err.code = permission;
    throw err;
  }
  const sub = await swReg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });
  await syncSubscription(sub, getPrefs());
  return sub;
}

async function unsubscribe() {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await supabase.rpc("delete_push_subscription", { p_endpoint: endpoint }).catch(() => {});
}

// ---- Dialog UI -------------------------------------------------------------

function openDialog() {
  const dialog = $("#notify-dialog");
  if (!dialog) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog() {
  const dialog = $("#notify-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function setNote(msg) {
  const note = $("#notify-note");
  if (!note) return;
  note.textContent = msg || "";
  note.hidden = !msg;
}

// Reflect the live state (subscribed?, permission, prefs) into the dialog and
// the header bell.
async function render() {
  const enableEl = $("#notify-enable");
  const dailyEl = $("#notify-daily");
  const commentsEl = $("#notify-comments");
  const detailEl = $("#notify-detail");
  const modeEl = $("#notify-mode");
  const dailyTimeRow = $("#notify-daily-time-row");
  const dailyTimeSel = $("#notify-daily-time");
  const bell = $("#notify-btn");

  // Unsupported (most often iOS Safari outside an installed PWA): the dialog can
  // only explain how to get notifications, so disable the switch and show a note.
  if (!pushSupported()) {
    if (bell) bell.classList.remove("is-on");
    if (enableEl) {
      enableEl.checked = false;
      enableEl.disabled = true;
    }
    if (detailEl) detailEl.hidden = true;
    setNote(
      isIos() && !isStandalone()
        ? 'On iPhone/iPad, add TierDrop to your Home Screen first (Share → "Add to Home Screen"), then open it from there to turn on notifications.'
        : "This browser doesn't support notifications."
    );
    return;
  }
  if (enableEl) enableEl.disabled = false;

  const prefs = getPrefs();
  const sub = await currentSubscription();
  const subscribed = Boolean(sub) && Notification.permission === "granted";

  if (bell) bell.classList.toggle("is-on", subscribed);

  if (enableEl) enableEl.checked = subscribed;
  if (dailyEl) dailyEl.checked = prefs.daily;
  if (commentsEl) commentsEl.checked = prefs.comments;
  if (dailyTimeSel) dailyTimeSel.value = String(prefs.dailyHour);
  if (dailyTimeRow) dailyTimeRow.hidden = !prefs.daily;
  if (modeEl) {
    modeEl.querySelectorAll('input[name="notify-mode"]').forEach((r) => {
      r.checked = r.value === prefs.mode;
    });
    modeEl.hidden = !prefs.comments;
  }
  if (detailEl) detailEl.hidden = !subscribed;

  // Contextual note for the cases where the master switch can't simply work.
  if (Notification.permission === "denied") {
    setNote("Notifications are blocked for this site. Re-enable them in your browser settings, then come back.");
  } else if (isIos() && !isStandalone()) {
    setNote('On iPhone/iPad, add TierDrop to your Home Screen first (Share → "Add to Home Screen"), then open it from there to turn on notifications.');
  } else {
    setNote("");
  }
}

// Re-sync the server row to match local prefs (only meaningful while subscribed).
async function persistPrefs(prefs) {
  setPrefs(prefs);
  const sub = await currentSubscription();
  if (sub) {
    try {
      await syncSubscription(sub, prefs);
    } catch (err) {
      console.error("Failed to sync notification prefs:", err);
    }
  }
}

function wireDialog() {
  const enableEl = $("#notify-enable");
  const dailyEl = $("#notify-daily");
  const commentsEl = $("#notify-comments");
  const modeEl = $("#notify-mode");
  const dailyTimeRow = $("#notify-daily-time-row");
  const dailyTimeSel = $("#notify-daily-time");

  // Populate the reminder-time dropdown once (12 AM … 11 PM, value = hour 0–23).
  if (dailyTimeSel && !dailyTimeSel.options.length) {
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = String(h);
      opt.textContent = hourLabel(h);
      dailyTimeSel.appendChild(opt);
    }
  }

  enableEl?.addEventListener("change", async () => {
    if (enableEl.checked) {
      setNote("");
      try {
        await subscribe();
      } catch (err) {
        enableEl.checked = false;
        if (err.code === "denied") {
          setNote("Notifications are blocked for this site. Re-enable them in your browser settings, then try again.");
        } else if (err.code === "default") {
          setNote("Permission wasn't granted — tap the switch again and choose Allow.");
        } else {
          setNote(`Couldn't enable notifications: ${err.message}`);
        }
      }
    } else {
      await unsubscribe();
    }
    await render();
  });

  dailyEl?.addEventListener("change", () => {
    const prefs = getPrefs();
    prefs.daily = dailyEl.checked;
    persistPrefs(prefs);
    if (dailyTimeRow) dailyTimeRow.hidden = !prefs.daily;
  });

  dailyTimeSel?.addEventListener("change", () => {
    const prefs = getPrefs();
    prefs.dailyHour = Number(dailyTimeSel.value);
    persistPrefs(prefs);
  });

  commentsEl?.addEventListener("change", () => {
    const prefs = getPrefs();
    prefs.comments = commentsEl.checked;
    persistPrefs(prefs);
    if (modeEl) modeEl.hidden = !prefs.comments;
  });

  modeEl?.querySelectorAll('input[name="notify-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      const prefs = getPrefs();
      prefs.mode = radio.value;
      persistPrefs(prefs);
    });
  });

  $("#notify-done")?.addEventListener("click", () => closeDialog());
  const dialog = $("#notify-dialog");
  dialog?.addEventListener("click", (e) => {
    if (e.target === dialog) closeDialog();
  });
}

// ---- Entry point -----------------------------------------------------------

export async function initPush() {
  const bell = $("#notify-btn");

  // Always register the service worker when supported — this is what makes
  // TierDrop installable (Add to Home Screen), independent of notifications.
  if ("serviceWorker" in navigator) {
    try {
      swReg = await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      console.error("Service worker registration failed:", err);
    }
  }

  if (!bell) return;

  // Notifications additionally need the forum backend (to store subscriptions)
  // and a configured VAPID key. Without those, leave the bell hidden — the rest
  // of the app, including install, is unaffected.
  if (!isConfigured || !vapidConfigured) return;

  const openIt = () => {
    openDialog();
    render();
  };

  // On iOS Safari outside an installed PWA, push isn't exposed at all — but we
  // still surface the bell so the dialog can explain "Add to Home Screen".
  if (!pushSupported()) {
    if (isIos() && !isStandalone()) {
      bell.hidden = false;
      bell.addEventListener("click", openIt);
      wireDialog();
    }
    return;
  }

  if (!swReg) return; // SW failed to register → no push

  bell.hidden = false;
  bell.addEventListener("click", openIt);
  wireDialog();

  // Reflect any existing subscription (e.g. the browser dropped it on key change).
  await render();

  // If already subscribed, re-sync the server row on load: this keeps the stored
  // timezone current when the user travels, and backfills it for subscriptions
  // made before time-of-day support existed. Fire-and-forget.
  if (await currentSubscription()) persistPrefs(getPrefs());
}
