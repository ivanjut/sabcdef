// sabcdef client. Plain ES modules, no build step.
// SortableJS is loaded globally from the CDN <script> in index.html.
import { loadCategories } from "./categories.js";
import { COUNTRIES, flagEmoji } from "./countries.js";
import { supabase, isConfigured } from "./supabase.js";
import { getDeviceId } from "./identity.js";
import { initPush } from "./push.js";

const $ = (sel, root = document) => root.querySelector(sel);

const TIER_LABELS = ["S", "A", "B", "C", "D", "E", "F"];

// ---- Small utilities ------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.max(1, Math.floor((Date.now() - then) / 1000));
  const units = [
    [31536000, "y"],
    [2592000, "mo"],
    [604800, "w"],
    [86400, "d"],
    [3600, "h"],
    [60, "m"]
  ];
  for (const [s, label] of units) {
    if (secs >= s) return `${Math.floor(secs / s)}${label} ago`;
  }
  return `${secs}s ago`;
}

let toastTimer;
// `variant` colour-codes the pill: "success" → green, "error" → red. Omit for
// the neutral default.
function toast(msg, variant) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
  }
  // A modal <dialog> renders in the top layer, above body content; show the
  // toast inside the frontmost open dialog (if any) so it isn't hidden behind
  // it. The toast is position:fixed, so the host doesn't move it on screen.
  const openDialogs = document.querySelectorAll("dialog[open]");
  const host = openDialogs.length ? openDialogs[openDialogs.length - 1] : document.body;
  if (el.parentElement !== host) host.appendChild(el);
  el.textContent = msg;
  el.classList.remove("toast--success", "toast--error");
  if (variant === "success" || variant === "error") el.classList.add(`toast--${variant}`);
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// localStorage helpers (namespaced, fail-safe)
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {
      /* private mode / quota — ignore */
    }
  }
};

// ---- App state ------------------------------------------------------------

const state = {
  today: null, // { day, name, theme, special_day, items, tierLabels }
  tierLists: [], // public submissions for the day (the global feed), newest first
  // When the page is opened from a share link, we render someone else's tiers
  // read-only instead of the local game.
  readOnly: false,
  preview: null, // { itemId: tierLabel } decoded from the share link
  previewAuthor: "", // sharer's display name, from the share link
  previewCountry: "" // sharer's ISO alpha-2 country code, from the share link
};

// ---- Discussion forums ------------------------------------------------------
// The page runs two independent discussion threads off the same backend: the
// live "today" forum below the board, and a "yesterday's results" forum inside
// the results modal. A forum bundles its own data (comments + suggestion
// reactions + sort order) with three day-related hooks and the DOM ids it
// renders into, so every function below operates on whichever forum it's handed:
//   • threadKey()   — value stored in / queried from the comments.day column;
//                     identifies which thread a comment belongs to.
//   • snapshotDay() — the day whose saved board a new comment snapshots, so
//                     "See Tier List" shows how the author actually ranked.
//   • categoryOf()  — the category those snapshots encode/decode against.
function createForum({ threadKey, snapshotDay, categoryOf, sel, allowSuggest = false }) {
  return { threadKey, snapshotDay, categoryOf, sel, allowSuggest, comments: [], reactions: {}, sort: "top" };
}

const mainForum = createForum({
  threadKey: () => state.today.day,
  snapshotDay: () => state.today.day,
  categoryOf: () => state.today,
  allowSuggest: true,
  sel: {
    root: "#forum", list: "#comments", count: "#comment-count", empty: "#comments-empty",
    form: "#comment-form", body: "#body-input", error: "#composer-error"
  }
});

// A fresh thread dedicated to discussing yesterday's averaged results. It's kept
// separate from yesterday's own live discussion via a distinct thread key — the
// "#results" suffix can't collide with a real YYYY-MM-DD day — so the previous
// day's live comments never appear here. New comments still snapshot the poster's
// *yesterday* board, so others can see how they ranked. "Yesterday" is relative
// to the real today (independent of any shared-list preview).
const resultsThreadKey = (day) => `${day}#results`;
const yesterdayForum = createForum({
  threadKey: () => resultsThreadKey(previousDay(dayString())),
  snapshotDay: () => previousDay(dayString()),
  categoryOf: () => categoryForDay(previousDay(dayString())),
  sel: {
    root: "#yr-forum", list: "#yr-comments", count: "#yr-comment-count", empty: "#yr-comments-empty",
    form: "#yr-comment-form", body: "#yr-body-input", error: "#yr-composer-error"
  }
});

const tiersKey = (day) => `sabcdef:tiers:${day}`;
// The encoded board this device last submitted for a day — drives the Submit
// button's "you have unsubmitted changes" attention pulse.
const submittedKey = (day) => `sabcdef:submitted:${day}`;
// The server-issued share_id of this device's last submission for a day, so a
// share link can point at the stored row without re-writing an unchanged board.
const shareIdKey = (day) => `sabcdef:tlshare:${day}`;
const votesKey = "sabcdef:votes";
const themeKey = "sabcdef:theme";
const profileKey = "sabcdef:profile"; // { name, country, visibility } — country is an ISO alpha-2 code; visibility is "public" | "private"
// Ids of the comments/suggestions this device authored. The server never sends
// each comment's device_id to clients (it's used to route reply notifications,
// so it stays private), so we remember our own posts locally to decide whether
// to show the "delete" menu. The real ownership check is enforced server-side by
// delete_comment, which only removes a row when the device id matches.
const mineKey = "sabcdef:mine";

// The anonymous per-device id lives in identity.js so push.js can tie a push
// subscription to the same device that posts comments/reactions. Here it's used
// to dedupe suggestion reactions and to stamp comments (so replies can be routed
// back to the device that posted the parent — see "reply" notifications).
const getVoterId = getDeviceId;

// Timestamp of the most recent drag end, so the synthetic click SortableJS may
// fire afterwards doesn't pop open the tap-to-assign picker.
let lastDragEndAt = 0;

// ---- Daily category (computed client-side) --------------------------------
// The category switches at a fixed moment worldwide so everyone is always on the
// same category and in the same comment thread, regardless of timezone. A
// "TierDrop day" begins at CATEGORY_SWITCH_UTC_HOUR:00 UTC; the category is then
// chosen by the number of whole days since the epoch (in that shifted frame),
// modulo the category count, so the choice is stable and rotates predictably.
//
// 05:00 UTC ≈ midnight–1 AM in the US East/Central, late evening on the US West
// coast, and 5–7 AM in the UK/EU — overnight for the Americas, an early-morning
// refresh for Europe. Change this one constant to retune when the day rolls over.
const CATEGORY_SWITCH_UTC_HOUR = 5;

// The day's category configs, loaded once at boot from the categories/ folder
// (see categories.js). Each entry is { date, name, theme, special_day, items }.
let CATEGORIES = [];

function dayString(date = new Date()) {
  // Shift back by the switch hour, then read the UTC date: the value only rolls
  // over at CATEGORY_SWITCH_UTC_HOUR:00 UTC, identically for every visitor.
  const shifted = new Date(date.getTime() - CATEGORY_SWITCH_UTC_HOUR * 3_600_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function categoryForDay(day) {
  // The calendar maps specific dates to specific categories. For any date the
  // calendar doesn't cover (old share links, dates past the planned range) fall
  // back to a deterministic rotation so the app always has something to show.
  const cat = CATEGORIES.find((c) => c.date === day) || rotationForDay(day);
  return { day, name: cat.name, theme: cat.theme, special_day: cat.special_day, items: cat.items, tierLabels: TIER_LABELS };
}

function rotationForDay(day) {
  const epochDays = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const index = ((epochDays % CATEGORIES.length) + CATEGORIES.length) % CATEGORIES.length;
  return CATEGORIES[index];
}

function getToday() {
  return categoryForDay(dayString());
}

// The TierDrop day before `day` (a YYYY-MM-DD). Computed in UTC so it lines up
// with how dayString() derives the day, regardless of the viewer's timezone.
function previousDay(day) {
  const d = new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// ---- Boot -----------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  $("#category-name").textContent = "Something went wrong loading the app.";
  $("#today-date").textContent = err.message;
});

async function init() {
  wireThemeToggle(); // independent of everything else
  wireProfile();

  // Load the daily category configs before anything that reads them.
  CATEGORIES = await loadCategories();

  const shared = getShareParams();
  let previewing = false;
  if (shared && CATEGORIES.length) {
    if (shared.shareId) {
      // DB-backed link: fetch the stored row (works for public and private).
      previewing = await enterSharedPreview(shared.shareId);
    } else {
      enterPreview(shared); // legacy self-contained link
      previewing = true;
    }
  }
  if (!previewing) {
    state.today = getToday();
    renderCategoryHead();
    renderTierList();
  }

  wireToolbar();
  wireSubmit();
  wireSubmitDialog();
  wireShareMenu();
  wireChipPicker();
  wireTierListDialog();
  wireYesterdayDialog();
  wireVotesDialog();
  wireSuggestInfo();
  startCountdown();

  // First visit (no profile saved on this device): prompt for name + country.
  // Skipped when viewing someone else's shared tier list.
  if (!previewing && !getProfile()) openProfileDialog("onboarding");

  if (isConfigured) {
    wireComposer(mainForum);
    wireComposer(yesterdayForum);
    wireSuggestComposer();
    wireSortToggle(mainForum);
    wireSortToggle(yesterdayForum);
    await loadComments(mainForum);
    await loadTierLists();
  } else {
    showForumOffline();
  }

  // Notification deep links: a tapped comment/reply notification routes to its
  // post. wireNotificationNav handles the case where the app is already open;
  // initDeepLink handles a cold launch. Both are no-ops on a normal open.
  wireNotificationNav();
  initDeepLink().catch((err) => console.error("Deep link failed:", err));

  // Push notifications (daily category + new comments). Self-contained: it
  // reveals the header bell only when supported + configured, and never blocks
  // the rest of the app if it fails.
  initPush().catch((err) => console.error("Push init failed:", err));
}

// ---- Notification deep links ----------------------------------------------
// A tapped comment/reply notification carries ?comment=<id>&thread=<day> (built
// by supabase/functions/send-push, opened by public/sw.js). We route to that
// post two ways:
//   • Cold launch — read the params from the launch URL, or, when iOS dropped
//     them on launch, from the service worker's stash (consumePendingNav).
//   • Already open — the SW posts a "notification-nav" message we handle live.
// The daily nudge carries no params, so it just lands on the home page.

const PENDING_CACHE = "tierdrop-pending-nav";
const PENDING_KEY = "/__pending_nav__";

// Read (and clear) the destination the service worker stashed for a cold launch.
// Ignores anything older than a minute so a long-ago tap can't hijack a normal
// open.
async function consumePendingNav() {
  try {
    if (!self.caches) return null;
    const cache = await caches.open(PENDING_CACHE);
    const res = await cache.match(PENDING_KEY);
    if (!res) return null;
    await cache.delete(PENDING_KEY);
    const { url, ts } = await res.json();
    if (!url || !ts || Date.now() - ts > 60_000) return null;
    return url;
  } catch {
    return null;
  }
}

function wireNotificationNav() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "notification-nav" && e.data.url) {
      navigateToCommentFromUrl(e.data.url);
    }
  });
}

// On boot, honor a deep link from the launch URL or the SW stash (the stash is
// the fallback for when iOS dropped the query string on a cold launch).
async function initDeepLink() {
  const stashed = await consumePendingNav(); // always clears the stash
  const here = new URLSearchParams(location.search);
  const target = here.get("comment") ? location.href : stashed;
  if (target) await navigateToCommentFromUrl(target);
}

// Strip our deep-link params so a refresh or re-share doesn't repeat the jump.
function cleanDeepLinkParams() {
  const url = new URL(location.href);
  if (!url.searchParams.has("comment") && !url.searchParams.has("thread")) return;
  url.searchParams.delete("comment");
  url.searchParams.delete("thread");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

async function navigateToCommentFromUrl(rawUrl) {
  let params;
  try {
    params = new URL(rawUrl, location.href).searchParams;
  } catch {
    return;
  }
  const commentId = params.get("comment");
  if (!commentId) return;
  const thread = params.get("thread") || "";
  cleanDeepLinkParams();
  await routeToComment(commentId, thread);
}

// Send the viewer to the comment in whichever live thread holds it: today's main
// discussion (in the page) or yesterday's results discussion (in its dialog).
async function routeToComment(commentId, thread) {
  if (thread === resultsThreadKey(previousDay(dayString()))) {
    await openYesterdayDialog(commentId);
    return;
  }
  // Default to today's main thread; init() has already loaded its comments.
  if (!focusComment("#comments", commentId)) {
    toast("Couldn't find that comment — it may be from an earlier day.");
  }
}

// Scroll a comment into view and flash it. Returns false if it isn't rendered.
function focusComment(listSel, commentId) {
  const el = document.querySelector(`${listSel} .comment[data-id="${CSS.escape(String(commentId))}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("comment-flash"); // restart the animation on a repeat tap
  void el.offsetWidth;
  el.classList.add("comment-flash");
  setTimeout(() => el.classList.remove("comment-flash"), 2200);
  return true;
}

// ---- Theme ----------------------------------------------------------------

function effectiveTheme() {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f6f7f9" : "#0f1115";
  updateThemeToggle(theme);
}

function updateThemeToggle(theme) {
  const btn = $("#theme-toggle");
  if (!btn) return;
  // Show the icon for the mode you'll switch TO.
  btn.textContent = theme === "light" ? "🌙" : "☀️";
  btn.setAttribute("aria-label", theme === "light" ? "Switch to dark theme" : "Switch to light theme");
}

function wireThemeToggle() {
  updateThemeToggle(effectiveTheme());
  $("#theme-toggle").addEventListener("click", () => {
    const next = effectiveTheme() === "light" ? "dark" : "light";
    applyTheme(next);
    store.set(themeKey, next);
  });
}

// ---- Profile (display name + country) -------------------------------------
// Stored on-device. Prompted for on the first visit (onboarding) and editable
// afterwards via the chip in the top-right of the header. Both fields optional.

function getProfile() {
  return store.get(profileKey, null); // null means "never onboarded"
}

function saveProfile(profile) {
  store.set(profileKey, {
    name: profile.name || "",
    country: profile.country || "",
    // Default to public; only "private" opts out of the global feed.
    visibility: profile.visibility === "private" ? "private" : "public"
  });
}

// "public" (the default, incl. for profiles saved before this setting existed)
// or "private". Public tier lists appear on the global feed when submitted.
function getVisibility() {
  return (getProfile() || {}).visibility === "private" ? "private" : "public";
}

function wireProfile() {
  wireCountryPicker();
  renderProfile();

  $("#profile-btn").addEventListener("click", () => openProfileDialog("edit"));
  // Each composer's "Posting as <name>" is also a shortcut into the editor.
  document.querySelectorAll(".identity-btn").forEach((b) =>
    b.addEventListener("click", () => openProfileDialog("edit"))
  );

  const dialog = $("#profile-dialog");

  $("#profile-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveProfile({
      name: $("#profile-name-input").value.trim().slice(0, 32),
      country: $("#profile-country-input").value,
      visibility: $("#profile-visibility-input").checked ? "public" : "private"
    });
    renderProfile();
    closeProfileDialog();
    toast("Profile saved");
  });

  $("#profile-skip-btn").addEventListener("click", () => {
    ensureOnboarded();
    closeProfileDialog();
  });

  // Esc / backdrop dismissal still counts as completing onboarding so the
  // dialog doesn't reappear on the next load.
  dialog.addEventListener("cancel", ensureOnboarded);
}

// Record that onboarding happened (with an empty profile) if nothing is saved
// yet, so a Skip / dismiss isn't re-prompted on the next visit.
function ensureOnboarded() {
  if (!getProfile()) saveProfile({ name: "", country: "" });
}

// ---- Searchable country picker --------------------------------------------
// A type-to-filter combobox over COUNTRIES with the popular countries pinned on
// top. The committed selection (an ISO code, or "" for none) lives in the hidden
// #profile-country-input so the rest of the profile code is unchanged; the
// visible search box always reflects that selection when it isn't being edited.

const POPULAR_COUNTRY_CODES = ["US", "GB", "FR", "IN", "NG", "JP"]; // USA, UK, France, India, Nigeria, Japan
let countryActiveIndex = -1; // highlighted option for arrow-key navigation

function countryByCode(code) {
  return COUNTRIES.find((c) => c.code === code) || null;
}

// "🇫🇷 France" for a code, or "" when there's no country selected.
function countryDisplay(code) {
  const c = countryByCode(code);
  return c ? `${flagEmoji(c.code)} ${c.name}` : "";
}

function countryOptionHtml(c) {
  return `<li class="country-option" role="option" data-code="${c.code}">${flagEmoji(c.code)} ${escapeHtml(c.name)}</li>`;
}

// Build the dropdown for the current query: with no query, "No country" + the
// pinned Popular group + the full alphabetical list; while searching, just the
// name/code matches.
function renderCountryOptions(query = "") {
  const list = $("#profile-country-listbox");
  if (!list) return;
  const q = query.trim().toLowerCase();
  const selected = $("#profile-country-input").value;

  let html = "";
  if (!q) {
    html += `<li class="country-option country-none" role="option" data-code="">No country</li>`;
    const popular = POPULAR_COUNTRY_CODES.map(countryByCode).filter(Boolean);
    html += `<li class="country-group" role="presentation">Popular</li>`;
    html += popular.map(countryOptionHtml).join("");
    html += `<li class="country-group" role="presentation">All countries</li>`;
    html += COUNTRIES.map(countryOptionHtml).join("");
  } else {
    const matches = COUNTRIES.filter(
      (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q
    );
    html = matches.length
      ? matches.map(countryOptionHtml).join("")
      : `<li class="country-empty" role="presentation">No matches</li>`;
  }
  list.innerHTML = html;

  // Mark the committed selection; reset the keyboard highlight.
  list.querySelectorAll(".country-option").forEach((el) =>
    el.setAttribute("aria-selected", el.dataset.code === selected ? "true" : "false")
  );
  countryActiveIndex = -1;
}

function openCountryList() {
  $("#profile-country-listbox").hidden = false;
  $("#profile-country-search").setAttribute("aria-expanded", "true");
}

function closeCountryList() {
  $("#profile-country-listbox").hidden = true;
  const input = $("#profile-country-search");
  input.setAttribute("aria-expanded", "false");
  countryActiveIndex = -1;
  // Drop any in-progress query and show the committed selection again.
  input.value = countryDisplay($("#profile-country-input").value);
}

// Commit a country code (or "") to the hidden input and reflect it in the box.
function setCountrySelection(code) {
  $("#profile-country-input").value = code || "";
  $("#profile-country-search").value = countryDisplay(code || "");
}

function selectCountry(code) {
  setCountrySelection(code);
  closeCountryList();
}

function moveCountryActive(delta) {
  const opts = [...$("#profile-country-listbox").querySelectorAll(".country-option")];
  if (!opts.length) return;
  countryActiveIndex = (countryActiveIndex + delta + opts.length) % opts.length;
  opts.forEach((el, i) => el.classList.toggle("is-active", i === countryActiveIndex));
  opts[countryActiveIndex].scrollIntoView({ block: "nearest" });
}

function wireCountryPicker() {
  const input = $("#profile-country-search");
  const list = $("#profile-country-listbox");
  const picker = $("#country-picker");
  if (!input || !list || !picker) return;

  // Focusing clears the box so the first keystroke starts a fresh search; the
  // committed selection is restored on close if nothing new is picked.
  input.addEventListener("focus", () => {
    input.value = "";
    renderCountryOptions("");
    openCountryList();
  });

  input.addEventListener("input", () => {
    renderCountryOptions(input.value);
    openCountryList();
  });

  input.addEventListener("keydown", (e) => {
    const opts = [...list.querySelectorAll(".country-option")];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.hidden) { renderCountryOptions(input.value); openCountryList(); }
      moveCountryActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveCountryActive(-1);
    } else if (e.key === "Enter") {
      if (!list.hidden) {
        e.preventDefault(); // never submit the form straight from the search box
        if (countryActiveIndex >= 0 && opts[countryActiveIndex]) {
          selectCountry(opts[countryActiveIndex].dataset.code);
        }
      }
    } else if (e.key === "Escape") {
      if (!list.hidden) {
        e.preventDefault();
        e.stopPropagation(); // close the list, not the whole dialog
        closeCountryList();
      }
    }
  });

  // mousedown keeps focus on the input (so its blur doesn't beat the click);
  // click commits the chosen option.
  list.addEventListener("mousedown", (e) => {
    if (e.target.closest(".country-option")) e.preventDefault();
  });
  list.addEventListener("click", (e) => {
    const opt = e.target.closest(".country-option");
    if (opt) selectCountry(opt.dataset.code);
  });

  // Close on focus leaving the picker (e.g. Tab) or a click outside it.
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (!picker.contains(document.activeElement)) closeCountryList();
    }, 0);
  });
  document.addEventListener("mousedown", (e) => {
    if (!picker.contains(e.target)) closeCountryList();
  });
}

function renderProfile() {
  const btn = $("#profile-btn");
  if (!btn) return;
  const profile = getProfile() || {};
  const name = (profile.name || "").trim();
  const flag = profile.country ? flagEmoji(profile.country) : "";

  const flagEl = btn.querySelector(".profile-flag");
  const nameEl = btn.querySelector(".profile-name");
  flagEl.textContent = flag;
  flagEl.hidden = !flag;
  nameEl.textContent = name || (flag ? "" : "Set profile");
  nameEl.hidden = !name && !!flag; // flag-only: hide the empty name span

  const hasAny = Boolean(name || flag);
  btn.classList.toggle("is-empty", !hasAny);
  btn.setAttribute("aria-label", hasAny ? "Edit your profile" : "Set up your profile");

  // Comments are posted under the profile name (or "anon" if it's blank),
  // prefixed with the country flag to match how they'll appear on a comment.
  // Both forums (today + yesterday) share the same identity, so update each.
  const idText = `${flagPrefix(profile.country)}${name || "anon"}`;
  document.querySelectorAll(".identity-btn").forEach((b) => (b.textContent = idText));
}

function openProfileDialog(mode = "edit") {
  const dialog = $("#profile-dialog");
  const profile = getProfile() || {};
  const onboarding = mode === "onboarding";

  $("#profile-name-input").value = profile.name || "";
  setCountrySelection(profile.country || "");
  closeCountryList();
  // Default new/never-set profiles to public (checked).
  $("#profile-visibility-input").checked = profile.visibility !== "private";

  $("#profile-dialog-title").textContent = onboarding ? "Welcome to TierDrop" : "Edit your profile";
  $("#profile-dialog-sub").textContent = onboarding
    ? "Set a display name and country, or skip for now — you can change these anytime."
    : "Update your display name and country. These are saved on this device.";
  $("#profile-skip-btn").textContent = onboarding ? "Skip" : "Cancel";

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("#profile-name-input").focus();
}

function closeProfileDialog() {
  const dialog = $("#profile-dialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

// ---- Category header ------------------------------------------------------

function renderCategoryHead() {
  const { day, name, special_day } = state.today;
  $("#category-name").textContent = name;
  $("#today-date").textContent = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
  const sd = $("#special-day");
  const label = (special_day || "").trim();
  sd.textContent = label;
  sd.hidden = !label;
}

// ---- Next-category countdown ----------------------------------------------
// The category rotates at CATEGORY_SWITCH_UTC_HOUR:00 UTC (see dayString), so we
// count down to the next occurrence of that UTC moment and tick once a second.

function msUntilNextDay() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(CATEGORY_SWITCH_UTC_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function startCountdown() {
  const el = $("#countdown");
  if (!el) return;
  const tick = () => {
    el.textContent = formatCountdown(msUntilNextDay());
    // Rolled past midnight with the page still open (not in a shared preview):
    // reload so the new day's category + discussion take over.
    if (!state.readOnly && state.today && dayString() !== state.today.day) location.reload();
  };
  tick();
  setInterval(tick, 1000);
}

// ---- Tier list ------------------------------------------------------------

function renderTierList() {
  const { day, items, tierLabels } = state.today;
  const tiersEl = $("#tiers");
  const poolEl = $("#pool");
  tiersEl.innerHTML = "";

  tierLabels.forEach((label) => {
    const row = document.createElement("div");
    row.className = "tier-row";

    const labelEl = document.createElement("div");
    labelEl.className = "tier-label";
    labelEl.textContent = label;
    labelEl.style.background = `var(--tier-${label}, var(--bg-elev-2))`;

    const zone = document.createElement("div");
    zone.className = "tier-dropzone";
    zone.dataset.tier = label;

    row.append(labelEl, zone);
    tiersEl.appendChild(row);
  });

  // In preview mode the placements come from the share link; otherwise from
  // this device's saved tier list. Anything unplaced goes to the pool.
  const saved = state.readOnly ? state.preview || {} : store.get(tiersKey(day), {}); // { itemId: tierLabel }
  poolEl.innerHTML = "";

  for (const item of items) {
    const chip = makeChip(item);
    const tier = saved[item.id];
    const target = tier && tier !== "pool" ? $(`.tier-dropzone[data-tier="${tier}"]`) : poolEl;
    (target || poolEl).appendChild(chip);
  }

  if (!state.readOnly) {
    initSortable();
    updateSubmitAttention();
  }
}

function makeChip(item) {
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.dataset.id = item.id;
  chip.title = item.name;
  // Outside preview, chips are operable by tap/click and keyboard (Enter/Space),
  // not just dragging. In a read-only shared preview they're inert.
  if (!state.readOnly) {
    chip.tabIndex = 0;
    chip.setAttribute("role", "button");
    chip.setAttribute("aria-haspopup", "menu");
    chip.setAttribute("aria-label", `${item.name} — tap to assign a tier`);
  }
  chip.innerHTML = `<span class="emoji">${escapeHtml(item.emoji || "•")}</span><span class="label">${escapeHtml(item.name)}</span>`;
  return chip;
}

function initSortable() {
  const zones = document.querySelectorAll(".tier-dropzone");
  zones.forEach((zone) => {
    new Sortable(zone, {
      group: "tier",
      animation: 150,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
      // No hold-delay: dragging starts the instant you move. A quick tap with no
      // movement stays a tap (handled by the assign-picker); the threshold gives
      // a few px of finger tolerance so a tap isn't mistaken for a drag.
      touchStartThreshold: 5,
      onSort: saveTierPlacements,
      onStart: closeMenuPopover,
      onEnd: () => {
        lastDragEndAt = Date.now();
      }
    });
  });
}

function saveTierPlacements() {
  const placement = {};
  document.querySelectorAll(".tier-dropzone").forEach((zone) => {
    const tier = zone.dataset.tier;
    zone.querySelectorAll(".chip").forEach((chip) => {
      placement[chip.dataset.id] = tier;
    });
  });
  store.set(tiersKey(state.today.day), placement);
  // A placement is a user action — filling the last slot here pops the prompt.
  updateSubmitAttention({ promptOnComplete: true });
}

// ---- Tap / click to assign --------------------------------------------------
// As an alternative to dragging, tapping a chip opens a small popover of tiers;
// picking one moves the chip there. Wired once via delegation on the (stable)
// tier-list section, so it survives re-renders from Reset.

// A single anchored popover menu at a time (the chip tier-picker and the
// suggestion reaction-picker share it). Caller supplies the inner HTML; any
// element inside with a [data-value] attribute becomes a selectable option.
let menuPopover = null;

function showMenuPopover(anchor, innerHtml, onSelect) {
  closeMenuPopover();
  closeInfoPopover();

  const backdrop = document.createElement("div");
  backdrop.className = "tier-picker-backdrop";

  const picker = document.createElement("div");
  picker.className = "tier-picker";
  picker.setAttribute("role", "menu");
  picker.innerHTML = innerHtml;

  // A modal <dialog> renders in the browser's top layer, above everything in the
  // normal layer regardless of z-index. So when the trigger is inside a dialog
  // (e.g. a comment's delete menu in the results modal) the popover must mount
  // in that same dialog, or it appears *behind* it. Both elements are
  // position:fixed, so the host doesn't change where they land on screen.
  const host = anchor.closest("dialog") || document.body;
  host.append(backdrop, picker);
  positionPicker(picker, anchor);

  backdrop.addEventListener("click", closeMenuPopover);
  picker.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-value]");
    if (!btn) return;
    onSelect(btn.dataset.value);
    closeMenuPopover();
  });

  const onKey = (e) => {
    if (e.key === "Escape") closeMenuPopover();
  };
  document.addEventListener("keydown", onKey);
  // The popover is anchored to an element; if the page moves, just dismiss it.
  window.addEventListener("scroll", closeMenuPopover, true);
  window.addEventListener("resize", closeMenuPopover);

  menuPopover = { backdrop, picker, onKey };
  picker.querySelector("[data-value]")?.focus();
}

function closeMenuPopover() {
  if (!menuPopover) return;
  const { backdrop, picker, onKey } = menuPopover;
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("scroll", closeMenuPopover, true);
  window.removeEventListener("resize", closeMenuPopover);
  backdrop.remove();
  picker.remove();
  menuPopover = null;
}

// A small anchored info popover (the suggest field's ⓘ widget uses it). Shows
// static help text and dismisses on outside-click, Escape, scroll, or resize.
// Reuses positionPicker so it sits right under its trigger.
let infoPopover = null;

function showInfoPopover(anchor, innerHtml) {
  closeMenuPopover();
  closeInfoPopover();

  const backdrop = document.createElement("div");
  backdrop.className = "tier-picker-backdrop";

  const pop = document.createElement("div");
  pop.className = "info-popover";
  pop.setAttribute("role", "tooltip");
  pop.innerHTML = innerHtml;

  // Mount in the trigger's dialog when there is one, so a modal's top layer
  // doesn't hide it (see showMenuPopover).
  const host = anchor.closest("dialog") || document.body;
  host.append(backdrop, pop);
  positionPicker(pop, anchor);

  backdrop.addEventListener("click", closeInfoPopover);
  const onKey = (e) => {
    if (e.key === "Escape") closeInfoPopover();
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", closeInfoPopover, true);
  window.addEventListener("resize", closeInfoPopover);

  anchor.setAttribute("aria-expanded", "true");
  infoPopover = { backdrop, pop, onKey, anchor };
}

function closeInfoPopover() {
  if (!infoPopover) return;
  const { backdrop, pop, onKey, anchor } = infoPopover;
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("scroll", closeInfoPopover, true);
  window.removeEventListener("resize", closeInfoPopover);
  backdrop.remove();
  pop.remove();
  anchor.setAttribute("aria-expanded", "false");
  infoPopover = null;
}

function wireChipPicker() {
  const section = $(".tierlist");

  section.addEventListener("click", (e) => {
    if (state.readOnly) return;
    const chip = e.target.closest(".chip");
    if (!chip) return;
    // Skip the click SortableJS may synthesize at the end of a drag.
    if (Date.now() - lastDragEndAt < 250) return;
    openTierPicker(chip);
  });

  section.addEventListener("keydown", (e) => {
    if (state.readOnly) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    const chip = e.target.closest(".chip");
    if (!chip) return;
    e.preventDefault();
    openTierPicker(chip);
  });
}

function currentTierOf(chip) {
  return chip.closest(".tier-dropzone")?.dataset.tier || "pool";
}

function openTierPicker(chip) {
  const item = state.today.items.find((i) => i.id === chip.dataset.id);
  const current = currentTierOf(chip);
  const opts = [...state.today.tierLabels, "pool"];

  const grid = opts
    .map((t) => {
      const isPool = t === "pool";
      const cls = `tier-picker-opt${isPool ? " is-pool" : ""}${t === current ? " is-current" : ""}`;
      const style = isPool ? "" : ` style="background:var(--tier-${t})"`;
      return `<button type="button" class="${cls}" data-value="${t}"${style}>${isPool ? "Unranked" : t}</button>`;
    })
    .join("");

  showMenuPopover(
    chip,
    `<div class="tier-picker-head">Assign <strong>${escapeHtml(item?.name || "")}</strong></div>
     <div class="tier-picker-grid">${grid}</div>`,
    (tier) => assignChipToTier(chip, tier)
  );
}

function positionPicker(picker, chip) {
  const r = chip.getBoundingClientRect();
  const pw = picker.offsetWidth;
  const ph = picker.offsetHeight;
  const margin = 8;

  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

  let top = r.bottom + margin; // prefer below the chip
  if (top + ph > window.innerHeight - margin) {
    top = r.top - ph - margin; // not enough room → place above
  }
  top = Math.max(margin, top);

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

function assignChipToTier(chip, tier) {
  const target = tier === "pool" ? $("#pool") : $(`.tier-dropzone[data-tier="${tier}"]`);
  if (!target || chip.parentElement === target) return;

  target.appendChild(chip);
  saveTierPlacements();

  // Brief flash so the move is visible when the chip lands off-screen-ish.
  chip.classList.remove("just-assigned");
  void chip.offsetWidth; // restart the animation
  chip.classList.add("just-assigned");

  toast(tier === "pool" ? "Moved to Unranked" : `Moved to ${tier}`);
}

function wireToolbar() {
  $("#reset-btn").addEventListener("click", () => {
    store.set(tiersKey(state.today.day), {});
    renderTierList();
    toast("Tier list reset");
  });
}

// ---- Submit (publish the board to the global feed) --------------------------
// The tier list reaches the server only when the player clicks Submit — not on
// every drag, and independent of commenting. Every submission is stored with the
// profile's visibility; the server only returns public rows, so a private
// submission is saved but never appears on the "Tier Lists" feed.

function wireSubmit() {
  const btn = $("#submit-btn");
  if (!btn) return;
  // Submitting needs the backend; without it the button has nothing to do.
  if (!isConfigured) {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", submitTierList);
}

// True once every item is on the board (the Unranked pool is empty).
function poolIsEmpty() {
  const pool = $("#pool");
  return Boolean(pool) && pool.querySelectorAll(".chip").length === 0;
}

// Guards a submit in flight: blocks double-submits and stops mid-request
// re-renders from flipping the button's disabled state out from under us.
let submitInFlight = false;
// Re-armed whenever the board leaves the "ready" state, so the completion
// dialog nudges once per fill rather than on every drag while it's already full.
let submitPromptArmed = true;

// Drive the Submit button's appearance from the board state:
//   • "is-ready"     — board full with unsubmitted changes: pulse for attention;
//   • "is-submitted" — board matches the last submit: grey out + disable;
//   • otherwise       — clickable, no pulse (mid-edit, or after a correction).
// When `promptOnComplete` is set (i.e. a user just placed a chip), filling the
// board also pops the "ready to submit?" dialog — once, until the board changes.
function updateSubmitAttention({ promptOnComplete = false } = {}) {
  const btn = $("#submit-btn");
  if (!btn || state.readOnly) return;
  const enc = encodeTierList(state.today, store.get(tiersKey(state.today.day), {}));
  const lastSubmitted = store.get(submittedKey(state.today.day), null);
  const submitted = lastSubmitted !== null && enc === lastSubmitted;
  const ready = poolIsEmpty() && !submitted;
  btn.classList.toggle("is-ready", ready);
  btn.classList.toggle("is-submitted", submitted);
  // While a request is in flight it owns `disabled`; otherwise grey out exactly
  // when there's nothing new to submit, and re-enable once the board changes.
  if (!submitInFlight) btn.disabled = submitted;

  if (!ready) submitPromptArmed = true;
  else if (promptOnComplete && submitPromptArmed) {
    submitPromptArmed = false;
    openSubmitDialog();
  }
}

// Persist the current board at the profile's visibility and return its stable
// share_id. The single point where a tier list is written to the server; used by
// both Submit and the share link. Returns { ok, shareId, visibility } or, on
// failure, { ok: false, reason, error }. Also records the encoding + share_id
// locally so an unchanged board can be re-shared without another write.
async function persistTierList() {
  const day = state.today.day;
  const tiers = encodeTierList(state.today, store.get(tiersKey(day), {}));
  if (!hasTierList(tiers)) return { ok: false, reason: "empty" };

  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null;
  const visibility = getVisibility();

  const { data, error } = await supabase.rpc("upsert_tier_list", {
    p_day: day,
    p_device: getVoterId(),
    p_tiers: tiers,
    p_author: name,
    p_country: country,
    p_visibility: visibility
  });
  if (error) return { ok: false, reason: "error", error };

  store.set(submittedKey(day), tiers);
  store.set(shareIdKey(day), data); // the RPC returns the row's share_id
  return { ok: true, shareId: data, visibility };
}

async function submitTierList() {
  if (state.readOnly || !isConfigured || submitInFlight) return;
  const btn = $("#submit-btn");
  submitInFlight = true;
  btn.disabled = true;
  try {
    const res = await persistTierList();
    if (!res.ok) {
      toast(res.reason === "empty" ? "Rank at least one item first." : res.error?.message || "Couldn't submit your tier list", "error");
      return;
    }
    await loadTierLists(); // resync the feed from the server (also re-renders)
    toast(res.visibility === "public" ? "Tier list submitted" : "Submitted privately", "success");
  } catch (err) {
    toast(err.message || "Couldn't submit your tier list", "error");
  } finally {
    submitInFlight = false;
    // Settle the button: greyed out if the submit stuck, clickable again on failure.
    updateSubmitAttention();
  }
}

// ---- Ready-to-submit dialog -------------------------------------------------
// Popped (once) the moment the board is filled, nudging the user to submit or
// keep editing. Submitting from here runs the same path as the Submit button.
function openSubmitDialog() {
  const dialog = $("#submit-dialog");
  if (!dialog || dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeSubmitDialog() {
  const dialog = $("#submit-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function wireSubmitDialog() {
  const dialog = $("#submit-dialog");
  if (!dialog) return;
  $("#submit-dialog-cancel")?.addEventListener("click", closeSubmitDialog);
  $("#submit-dialog-confirm")?.addEventListener("click", () => {
    closeSubmitDialog();
    submitTierList();
  });
  // Click on the backdrop dismisses, same as the app's other dialogs.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeSubmitDialog();
  });
}

// ---- Share ------------------------------------------------------------------
// The "Share" button opens a small menu with two options:
//   1. Share link — a URL that, when opened, shows the sharer's tiers as a
//      read-only preview. Placements are encoded positionally into the URL so
//      no backend is needed (this is a static site).
//   2. Copy tier list — the existing plain-text summary.

function wireShareMenu() {
  const btn = $("#share-btn");
  const list = $("#share-menu-list");
  if (!btn || !list) return;

  const onDocClick = (e) => {
    if (!e.target.closest(".share-menu")) closeShareMenu();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      closeShareMenu();
      btn.focus();
    }
  };

  function closeShareMenu() {
    if (list.hidden) return;
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  }
  function openShareMenu() {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't let this same click reach the doc-close handler
    list.hidden ? openShareMenu() : closeShareMenu();
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest(".share-menu-item");
    if (!item) return;
    closeShareMenu();
    if (item.dataset.share === "link") shareLink();
    else copyTierListText();
  });
}

async function shareLink() {
  if (state.readOnly) return;
  const day = state.today.day;
  const enc = encodeTierList(state.today, store.get(tiersKey(day), {}));
  if (!hasTierList(enc)) {
    toast("Rank at least one item first.");
    return;
  }

  let url;
  if (isConfigured) {
    // DB-backed link: persist the board (so the link points at a stored row) and
    // build ?tl=<share_id>. Reuse the saved share_id when the board is unchanged
    // since it was last persisted, so re-sharing doesn't write again. This works
    // for private lists too — they're stored, just kept off the global feed.
    let shareId = store.get(shareIdKey(day), null);
    if (!shareId || enc !== store.get(submittedKey(day), null)) {
      const res = await persistTierList();
      if (!res.ok) {
        toast(res.error?.message || "Couldn't create a share link");
        return;
      }
      shareId = res.shareId;
      await loadTierLists(); // a public board now appears on the feed
      updateSubmitAttention();
    }
    url = buildSharedUrl(shareId);
  } else {
    // No backend configured: fall back to a self-contained URL-encoded link.
    url = buildShareUrl();
  }

  // Prefer the native share sheet where available (mobile, some desktops).
  if (navigator.share) {
    try {
      await navigator.share({ title: "Tier Drop", text: `My ${state.today.name} tier list`, url });
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user dismissed the sheet
      // anything else: fall through to clipboard
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Share link copied to clipboard");
  } catch {
    toast("Couldn't copy — clipboard blocked");
  }
}

async function copyTierListText() {
  try {
    await navigator.clipboard.writeText(buildShareText());
    toast("Tier list copied to clipboard");
  } catch {
    toast("Couldn't copy — clipboard blocked");
  }
}

function buildShareText() {
  const { name, day, tierLabels } = state.today;
  const byId = Object.fromEntries(state.today.items.map((i) => [i.id, i]));
  const placement = store.get(tiersKey(day), {});
  const lines = [`Tier Drop — ${name} (${day})`];
  for (const label of tierLabels) {
    const names = Object.entries(placement)
      .filter(([, t]) => t === label)
      .map(([id]) => byId[id]?.name)
      .filter(Boolean);
    if (names.length) lines.push(`${label}: ${names.join(", ")}`);
  }
  return lines.join("\n");
}

// Encode a tier list positionally: one char per item (in category order), using
// the tier letter or "-" for unranked. Compact and stable for a given day.
function encodeTierList(today, placement) {
  return today.items.map((item) => (TIER_LABELS.includes(placement[item.id]) ? placement[item.id] : "-")).join("");
}

function decodeTierList(today, str) {
  const chars = String(str || "").split("");
  const placement = {};
  today.items.forEach((item, i) => {
    const c = chars[i];
    if (c && TIER_LABELS.includes(c)) placement[item.id] = c;
  });
  return placement;
}

// True when an encoded tier list places at least one item into a tier (i.e. it's
// not all "-" / empty). Used to decide whether to offer "See Tier List".
function hasTierList(str) {
  return Boolean(str) && [...str].some((c) => TIER_LABELS.includes(c));
}

// A country flag + trailing space to prefix a name with, or "" when there's no
// country. flagEmoji only ever returns safe regional-indicator codepoints, so
// the result is safe to drop into innerHTML.
function flagPrefix(country) {
  const flag = flagEmoji(country);
  return flag ? `${flag} ` : "";
}

// A short, stable link to a stored tier list: ?tl=<share_id>. The recipient's
// client fetches the row (see enterSharedPreview), so the board itself isn't in
// the URL. This is the link used whenever the backend is available.
function buildSharedUrl(shareId) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("tl", shareId);
  return url.toString();
}

// Legacy self-contained link (?d=&r=&n=&c=): the whole board is encoded in the
// URL, needing no backend. Kept as the offline fallback and so older shared links
// still open.
function buildShareUrl() {
  const placement = store.get(tiersKey(state.today.day), {});
  const profile = getProfile() || {};
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("d", state.today.day);
  url.searchParams.set("r", encodeTierList(state.today, placement));
  // Carry the sharer's display name + country so the preview can attribute it.
  const name = (profile.name || "").trim().slice(0, 32);
  if (name) url.searchParams.set("n", name);
  if (profile.country) url.searchParams.set("c", profile.country);
  return url.toString();
}

function getShareParams() {
  const params = new URLSearchParams(location.search);
  // DB-backed link (preferred): ?tl=<share_id>.
  const shareId = params.get("tl");
  if (shareId) return { shareId };
  // Legacy self-contained link (?d=&r=…) — still honored so old shares work.
  const day = params.get("d");
  const tierList = params.get("r");
  // Day must look like YYYY-MM-DD; otherwise ignore and load the normal game.
  if (day && tierList != null && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { day, tierList, name: params.get("n") || "", country: params.get("c") || "" };
  }
  return null;
}

// ---- Shared tier-list preview -----------------------------------------------

function enterPreview({ day, tierList, name, country }) {
  state.today = categoryForDay(day);
  state.readOnly = true;
  state.preview = decodeTierList(state.today, tierList);
  state.previewAuthor = (name || "").trim().slice(0, 32);
  state.previewCountry = country || "";
  document.body.classList.add("preview-mode");
  renderCategoryHead();
  renderPreviewBanner();
  renderTierList();
}

// Open a DB-backed share link (?tl=<share_id>): fetch the stored row — public or
// private — by its share_id and render it read-only. Returns true if shown, or
// false (so the caller falls back to the normal game) when it can't be loaded.
async function enterSharedPreview(shareId) {
  if (!isConfigured) return false; // no backend to fetch from
  try {
    const { data, error } = await supabase.rpc("get_shared_tier_list", { p_share_id: shareId });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) {
      toast("Couldn't load that shared tier list");
      return false;
    }
    enterPreview({ day: row.day, tierList: row.tiers, name: row.author, country: row.country });
    return true;
  } catch {
    toast("Couldn't load that shared tier list");
    return false;
  }
}

function exitPreview() {
  state.readOnly = false;
  state.preview = null;
  document.body.classList.remove("preview-mode");
  // Strip the share params so a refresh / re-share reflects the local game.
  history.replaceState(null, "", location.pathname);
  $("#preview-banner")?.remove();
  state.today = getToday();
  renderCategoryHead();
  renderTierList();

  // Onboarding is skipped while viewing a shared link, so a visitor who arrived
  // via a share may not have a name set yet. Now that they're starting their own
  // fresh tier list, prompt for a display name + country. We re-prompt even if
  // they previously skipped (empty name persisted) — arriving through a share is
  // exactly when we want to encourage attaching a name. Gated on a missing name
  // so this only fires here, not on the normal boot path for repeat visitors.
  const profile = getProfile();
  if (!profile || !(profile.name || "").trim()) openProfileDialog("onboarding");
}

function renderPreviewBanner() {
  $("#preview-banner")?.remove();
  const banner = document.createElement("div");
  banner.id = "preview-banner";
  banner.className = "preview-banner";
  const name = (state.previewAuthor || "").trim();
  const who = name
    ? `<strong>${flagPrefix(state.previewCountry)}${escapeHtml(name)}</strong>'s`
    : "a shared";
  banner.innerHTML = `
    <span class="preview-text">You're viewing ${who} <strong>${escapeHtml(state.today.name)}</strong> tier list.</span>
    <button id="exit-preview-btn" class="btn btn-primary" type="button">Make your own</button>
  `;
  const section = $(".tierlist");
  section.insertBefore(banner, section.firstChild);
  $("#exit-preview-btn").addEventListener("click", exitPreview);
}

// ---- Forum (Supabase) -----------------------------------------------------

function showForumOffline() {
  const empty = $("#comments-empty");
  empty.hidden = false;
  empty.textContent = "Discussion is offline — add your Supabase keys in config.js to enable it.";
  const form = $("#comment-form");
  if (form) form.hidden = true;
  // Suggestions live in the same backend, so hide the box when it's unavailable.
  const suggest = $("#suggest");
  if (suggest) suggest.hidden = true;
  // The tier-lists feed comes from the backend, so there's nothing to show.
  const tierlists = $("#tierlists");
  if (tierlists) tierlists.hidden = true;
  $("#comment-count").textContent = "0";
}

async function loadComments(forum) {
  const { data, error } = await supabase
    .from("comments")
    .select("id,parent_id,author,country,body,tier_list,score,created_at,kind,deleted")
    .eq("day", forum.threadKey())
    .order("created_at", { ascending: true });

  if (error) {
    const empty = $(forum.sel.empty);
    empty.hidden = false;
    empty.textContent = `Couldn't load the discussion: ${error.message}`;
    return;
  }
  forum.comments = data || [];
  const suggestionIds = forum.comments.filter((c) => c.kind === "suggestion").map((c) => c.id);
  await loadReactions(forum, suggestionIds);
  renderComments(forum);
}

// Pull the tier reactions for the forum's suggestions, grouped by comment id.
async function loadReactions(forum, commentIds) {
  forum.reactions = {};
  if (!commentIds.length) return;
  const { data, error } = await supabase
    .from("suggestion_reactions")
    .select("comment_id,voter_id,tier,author,country,created_at")
    .in("comment_id", commentIds);
  if (error) return; // reactions are non-essential; the discussion still loads
  for (const r of data || []) (forum.reactions[r.comment_id] ||= []).push(r);
}

function buildTree(forum) {
  const nodes = new Map();
  forum.comments.forEach((c) => nodes.set(c.id, { ...c, children: [] }));
  const roots = [];
  nodes.forEach((node) => {
    if (node.parent_id != null && nodes.has(node.parent_id)) {
      nodes.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  });

  const cmp =
    forum.sort === "top"
      ? (a, b) => b.score - a.score || a.created_at.localeCompare(b.created_at)
      : (a, b) => b.created_at.localeCompare(a.created_at);

  const sortRec = (list) => {
    list.sort(cmp);
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function renderComments(forum) {
  const container = $(forum.sel.list);
  if (!container) return;
  const roots = buildTree(forum);

  $(forum.sel.count).textContent = forum.comments.length;
  const empty = $(forum.sel.empty);
  empty.hidden = forum.comments.length > 0;
  if (!forum.comments.length) empty.textContent = "No comments yet. Start the debate.";

  container.innerHTML = "";
  const votes = store.get(votesKey, {});
  roots.forEach((node) => container.appendChild(renderNode(forum, node, votes, 0)));
}

// ---- "My posts" ownership (for the delete menu) ----------------------------
// We can only know a comment is ours from the local list of ids we authored, so
// these helpers keep that list in sync with localStorage.
function myPostIds() {
  return store.get(mineKey, []);
}
function isMine(id) {
  return myPostIds().includes(id);
}
function markMine(id) {
  const mine = myPostIds();
  if (!mine.includes(id)) {
    mine.push(id);
    store.set(mineKey, mine);
  }
}
function unmarkMine(id) {
  store.set(mineKey, myPostIds().filter((x) => x !== id));
}

function renderNode(forum, node, votes, depth) {
  const myVote = votes[node.id] || 0;
  const isSuggestion = node.kind === "suggestion";

  // A node is a comment plus (optionally) the thread of its replies. The thread
  // is a sibling of the comment — not nested inside its body — so the reply line
  // lines up with the left edge of the comment instead of its text column.
  const wrapper = document.createElement("div");
  wrapper.className = "comment-node";

  const el = document.createElement("div");
  el.className = `comment${isSuggestion ? " is-suggestion" : ""}`;
  el.dataset.id = node.id;

  // A soft-deleted comment that still has replies renders as a "[deleted]"
  // tombstone: no content, no votes, no actions — just enough to keep the thread
  // (its replies, rendered below) anchored.
  if (node.deleted) {
    el.classList.add("is-deleted");
    el.innerHTML = `
      <div class="comment-body">
        <div class="comment-meta">
          <span class="comment-time">${timeAgo(node.created_at)}</span>
        </div>
        <div class="comment-text comment-tombstone">[deleted]</div>
      </div>
    `;
    wrapper.appendChild(el);
    if (node.children.length) {
      const thread = document.createElement("div");
      thread.className = depth < 5 ? "comment-thread" : "";
      node.children.forEach((child) => thread.appendChild(renderNode(forum, child, votes, depth + 1)));
      wrapper.appendChild(thread);
    }
    return wrapper;
  }

  // Suggestions get a badge + a prominent item name, and a "Vote" button that
  // ranks the item into a tier, plus a "See Rankings" breakdown of those votes.
  // Everything else (score, reply) works the same as a normal comment.
  const text = isSuggestion
    ? `<div class="comment-text"><span class="suggest-item">${escapeHtml(node.body)}</span></div>`
    : `<div class="comment-text">${escapeHtml(node.body)}</div>`;

  const actions = isSuggestion
    ? `<button class="reply-btn" data-action="reply">Reply</button>
       <button class="react-btn" data-action="react">${reactBtnLabel(forum, node.id)}</button>
       <button class="ranking-btn" data-action="votes">See Rankings <span class="rcount">${reactionCount(forum, node.id)}</span></button>`
    : `<button class="reply-btn" data-action="reply">Reply</button>
       ${hasTierList(node.tier_list) ? `<button class="ranking-btn" data-action="tierlist">See Tier List</button>` : ""}`;

  // The author (same device that posted) gets a meatball menu at the top right, on
  // the name/time line, to delete their own comment/suggestion. Everyone else sees
  // no menu at all.
  const ownerMenu = isMine(node.id)
    ? `<button class="menu-btn" data-action="menu" aria-label="More options" aria-haspopup="menu">&#8943;</button>`
    : "";

  el.innerHTML = `
    <div class="votes">
      <button class="vote-btn up ${myVote === 1 ? "is-active" : ""}" data-dir="up" aria-label="Upvote">▲</button>
      <span class="score">${node.score}</span>
      <button class="vote-btn down ${myVote === -1 ? "is-active" : ""}" data-dir="down" aria-label="Downvote">▼</button>
    </div>
    <div class="comment-body">
      <div class="comment-meta">
        <span class="comment-author">${flagPrefix(node.country)}${escapeHtml(node.author)}</span>
        ${isSuggestion ? `<span class="suggest-tag">💡 Suggestion</span>` : ""}
        <span class="comment-time">${timeAgo(node.created_at)}</span>
        ${ownerMenu}
      </div>
      ${text}
      <div class="comment-actions">${actions}</div>
    </div>
  `;

  el.querySelector(".vote-btn.up").addEventListener("click", () => vote(forum, node.id, 1));
  el.querySelector(".vote-btn.down").addEventListener("click", () => vote(forum, node.id, -1));
  el.querySelector('[data-action="reply"]').addEventListener("click", () => toggleReplyForm(forum, el, node.id));
  el.querySelector('[data-action="tierlist"]')?.addEventListener("click", () => openTierListDialog(forum, node));
  el.querySelector('[data-action="react"]')?.addEventListener("click", (e) => openReactionPicker(forum, e.currentTarget, node));
  el.querySelector('[data-action="votes"]')?.addEventListener("click", () => openVotesDialog(forum, node));
  el.querySelector('[data-action="menu"]')?.addEventListener("click", (e) => openCommentMenu(forum, e.currentTarget, node));

  wrapper.appendChild(el);

  if (node.children.length) {
    const thread = document.createElement("div");
    // Cap visual indentation so deep chains don't run off a phone screen.
    thread.className = depth < 5 ? "comment-thread" : "";
    node.children.forEach((child) => thread.appendChild(renderNode(forum, child, votes, depth + 1)));
    wrapper.appendChild(thread);
  }
  return wrapper;
}

// ---- Deleting your own comment ----------------------------------------------
// The meatball menu only renders on posts this device authored (see isMine). The
// menu offers a single "Delete" action; the actual ownership check is enforced
// server-side by delete_comment (the device id must match), so this is safe even
// though the menu's visibility is decided from local state.
function openCommentMenu(forum, anchor, node) {
  const label = node.kind === "suggestion" ? "suggestion" : "comment";
  showMenuPopover(
    anchor,
    `<button type="button" class="menu-item is-danger" data-value="delete">Delete ${label}</button>`,
    (value) => {
      if (value === "delete") deleteComment(forum, node);
    }
  );
}

async function deleteComment(forum, node) {
  const label = node.kind === "suggestion" ? "suggestion" : "comment";
  const { data, error } = await supabase.rpc("delete_comment", {
    c_id: node.id,
    d_id: getVoterId()
  });

  if (error) {
    toast(`Couldn't delete: ${error.message}`);
    return;
  }
  // 'denied' means the device id didn't match (e.g. local state thought it was
  // ours but the server disagrees) — drop the stale marker and bail.
  if (data === "denied") {
    unmarkMine(node.id);
    renderComments(forum);
    toast(`You can only delete a ${label} from the device that posted it`);
    return;
  }

  unmarkMine(node.id);
  // The server soft-deletes when the post has replies (keep a tombstone) and hard
  // deletes otherwise. Mirror whichever it did so we don't have to reload.
  if (data === "tombstoned") {
    tombstoneCommentLocally(forum, node.id);
  } else {
    removeCommentLocally(forum, node.id);
  }
  renderComments(forum);
  toast(`${label[0].toUpperCase()}${label.slice(1)} deleted`);
}

// Mirror a server-side soft delete: keep the row (its replies stay threaded under
// it) but scrub its content and flag it so renderNode shows the tombstone.
function tombstoneCommentLocally(forum, id) {
  const c = forum.comments.find((x) => x.id === id);
  if (!c) return;
  c.deleted = true;
  c.body = "[deleted]";
  c.author = "[deleted]";
  c.country = null;
  c.tier_list = null;
  delete forum.reactions[id];
}

// Remove a comment and all of its replies from local state. The DB cascades the
// delete (parent_id ... on delete cascade), so we mirror that here rather than
// reload, sweeping up descendants by walking parent_id.
function removeCommentLocally(forum, id) {
  const removed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of forum.comments) {
      if (c.parent_id != null && removed.has(c.parent_id) && !removed.has(c.id)) {
        removed.add(c.id);
        grew = true;
      }
    }
  }
  forum.comments = forum.comments.filter((c) => !removed.has(c.id));
  for (const rid of removed) delete forum.reactions[rid];
}

// ---- Comment tier-list popup ------------------------------------------------
// Each comment carries a snapshot of its author's whole tier list at post time
// (see postComment). "See Tier List" opens a read-only visual of it in a dialog.

function tierListHtml(today, placement) {
  const byTier = Object.fromEntries(today.tierLabels.map((l) => [l, []]));
  for (const item of today.items) {
    const tier = placement[item.id];
    if (tier && byTier[tier]) byTier[tier].push(item);
  }
  const rows = today.tierLabels
    .map((label) => {
      const chips = byTier[label]
        .map(
          (item) =>
            `<div class="chip ranking-chip"><span class="emoji">${escapeHtml(item.emoji || "•")}</span><span class="label">${escapeHtml(item.name)}</span></div>`
        )
        .join("");
      return `
        <div class="tier-row">
          <div class="tier-label" style="background:var(--tier-${label})">${label}</div>
          <div class="tier-dropzone">${chips}</div>
        </div>`;
    })
    .join("");
  return `<div class="tiers">${rows}</div>`;
}

function openTierListDialog(forum, node) {
  const dialog = $("#tierlist-dialog");
  if (!dialog) return;
  // Decode the positional tier list against the category of the forum's day
  // (today for the main forum, yesterday for the results-modal forum).
  const category = forum.categoryOf();
  const placement = decodeTierList(category, node.tier_list);

  $("#tierlist-dialog-title").textContent = `${flagPrefix(node.country)}${node.author || "anon"}'s tier list`;
  $("#tierlist-dialog-sub").textContent = `${category.name} · ${category.day}`;
  $("#tierlist-dialog-body").innerHTML = tierListHtml(category, placement);

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeTierListDialog() {
  const dialog = $("#tierlist-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function wireTierListDialog() {
  const dialog = $("#tierlist-dialog");
  if (!dialog) return;
  $("#tierlist-dialog-close")?.addEventListener("click", closeTierListDialog);
  // A click on the backdrop reports the dialog itself as the target.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeTierListDialog();
  });
}

// ---- Yesterday's results ----------------------------------------------------
// The community's consensus for the previous day. Tiers are scored S=0…F=6, so a
// lower mean is a better placement. Per item we compute the mean (its fractional
// position on the S→F scale), the spread (population standard deviation), and the
// observed range — then round the mean to a tier for the headline board. Items
// nobody ranked are left out. An item is "contested" when its rankings are widely
// spread (high standard deviation), which we both tag inline and call out.

const CONTESTED_STD = 1.7; // ≈ rankings spread well beyond three tiers

// Map an item's mean tier index (0 = S … 6 = F) to its averaged tier label.
//
// The two end tiers each own a FULL unit of average — S = [0, 1), F = [5, 6] —
// so an item the majority parks at an extreme isn't bumped inward by a few
// dissenting votes (e.g. a mostly-S item averaging 0.54 reads as S, not A). The
// five middle tiers (A–E) split the remaining [1, 5] range evenly, 0.8 wide
// each. (A plain Math.round instead gives S/F only half-width buckets, which is
// why those tiers used to be so hard to reach.)
function tierForMean(mean) {
  const last = TIER_LABELS.length - 1; // 6 → F
  if (mean < 1) return TIER_LABELS[0]; // S: [0, 1)
  if (mean >= last - 1) return TIER_LABELS[last]; // F: [last-1, last]
  const width = (last - 2) / (last - 1); // middle bucket width (0.8 for 7 tiers)
  // The 1e-9 nudge keeps an average that lands exactly on a boundary (e.g. 3.4 =
  // 17/5) in the bucket it opens, rather than one tier low from float dust. It's
  // far smaller than any gap between two distinct averages, so it's otherwise inert.
  return TIER_LABELS[1 + Math.floor((mean - 1) / width + 1e-9)]; // A–E across [1, last-1)
}

function tierStats(category, rows) {
  // Decode each submission once, then summarise per item (keeping id types intact).
  const placements = rows.map((row) => decodeTierList(category, row.tiers));
  const stats = [];
  for (const item of category.items) {
    const idxs = [];
    for (const placement of placements) {
      const idx = TIER_LABELS.indexOf(placement[item.id]);
      if (idx >= 0) idxs.push(idx);
    }
    if (!idxs.length) continue;
    const mean = idxs.reduce((a, b) => a + b, 0) / idxs.length;
    const std = Math.sqrt(idxs.reduce((a, b) => a + (b - mean) ** 2, 0) / idxs.length);
    stats.push({
      item,
      n: idxs.length,
      mean,
      std,
      min: Math.min(...idxs),
      max: Math.max(...idxs),
      tier: tierForMean(mean),
      contested: idxs.length >= 2 && std >= CONTESTED_STD
    });
  }
  // Best average first, mirroring the S→F board (and sub-ordering within a tier).
  stats.sort((a, b) => a.mean - b.mean || a.item.name.localeCompare(b.item.name));
  return stats;
}

const clampPct = (v) => Math.max(0, Math.min(100, v));

// One breakdown row per ranked item: a name, a track showing the spread (band)
// and the average (marker), then the rounded tier. Contested rows are tagged.
function yesterdayItemRow(s) {
  const span = TIER_LABELS.length - 1; // index range 0…6
  const markerPct = clampPct((s.mean / span) * 100);
  const lowPct = clampPct(((s.mean - s.std) / span) * 100);
  const highPct = clampPct(((s.mean + s.std) / span) * 100);
  return `
    <div class="yr-item${s.contested ? " is-contested" : ""}">
      <span class="yr-name">
        <span class="emoji">${escapeHtml(s.item.emoji || "•")}</span>
        <span class="yr-label">${escapeHtml(s.item.name)}</span>
        ${s.contested ? `<span class="yr-flag" role="img" aria-label="Contested">🔥</span>` : ""}
      </span>
      <span class="yr-scale" aria-hidden="true">
        <span class="yr-spread" style="left:${lowPct}%;width:${Math.max(0, highPct - lowPct)}%"></span>
        <span class="yr-marker" style="left:${markerPct}%;background:var(--tier-${s.tier})"></span>
      </span>
      <span class="yr-meta">
        <span class="yr-tier" style="background:var(--tier-${s.tier})">${s.tier}</span>
      </span>
    </div>`;
}

function yesterdayBodyHtml(category, stats, n) {
  const placement = Object.fromEntries(stats.map((s) => [s.item.id, s.tier]));
  const rows = stats.map(yesterdayItemRow).join("");

  // Tag every divisive item inline, but only call out the few most contested.
  const contested = stats
    .filter((s) => s.contested)
    .sort((a, b) => b.std - a.std)
    .slice(0, 5);
  const contestedHtml = contested.length
    ? `<div class="yr-contested">
         <h3 class="yr-section-title">🔥 Most contested</h3>
         <ul class="yr-contested-list">
           ${contested
             .map(
               (s) =>
                 `<li><span class="emoji">${escapeHtml(s.item.emoji || "•")}</span> <strong>${escapeHtml(
                   s.item.name
                 )}</strong> — ranged ${TIER_LABELS[s.min]}–${TIER_LABELS[s.max]} across ${s.n} list${
                   s.n === 1 ? "" : "s"
                 }</li>`
             )
             .join("")}
         </ul>
       </div>`
    : `<p class="yr-consensus">Broad consensus — no item was especially divisive.</p>`;

  return `
    ${tierListHtml(category, placement)}
    <div class="yr-breakdown">
      <h3 class="yr-section-title">Average position</h3>
      <p class="yr-legend">
        Each item's average across ${n} list${n === 1 ? "" : "s"}, on the S→F scale.
        The colored line marks the average; the band shows how spread the rankings were to one standard deviation.
      </p>
      <div class="yr-items">${rows}</div>
    </div>
    ${contestedHtml}`;
}

async function openYesterdayDialog(focusCommentId = null) {
  const dialog = $("#yesterday-dialog");
  if (!dialog) return;

  // Yesterday relative to the real today (independent of any shared-list preview).
  const day = previousDay(dayString());
  const category = categoryForDay(day);
  const body = $("#yesterday-dialog-body");

  $("#yesterday-dialog-title").textContent = "Yesterday's results";
  $("#yesterday-dialog-sub").textContent = `${category.name} · ${day}`;
  body.innerHTML = `<p class="empty">Loading…</p>`;

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");

  // The discussion thread for yesterday's day lives in this modal. It's
  // independent of whether anyone submitted, so load it whenever the backend is
  // available — in parallel with the results below.
  const forumEl = $("#yr-forum");
  if (forumEl) forumEl.hidden = !isConfigured;
  const commentsLoaded = isConfigured ? loadComments(yesterdayForum) : Promise.resolve();
  // Opened from a notification: scroll to that comment once the thread renders.
  if (focusCommentId != null) {
    commentsLoaded.then(() => {
      if (!focusComment("#yr-comments", focusCommentId)) {
        toast("Couldn't find that comment — it may be from an earlier day.");
      }
    });
  }

  if (!isConfigured) {
    body.innerHTML = `<p class="empty">Results are offline — add your Supabase keys in config.js to enable them.</p>`;
    return;
  }

  const { data, error } = await supabase.from("tier_lists").select("tiers").eq("day", day);
  if (error) {
    body.innerHTML = `<p class="empty">Couldn't load yesterday's results.</p>`;
    return;
  }

  // Only count submissions that actually placed at least one item.
  const rows = (data || []).filter((row) => hasTierList(row.tiers));
  if (!rows.length) {
    body.innerHTML = `<p class="empty">No tier lists were submitted yesterday.</p>`;
    return;
  }

  const n = rows.length;
  $("#yesterday-dialog-sub").textContent = `Average of ${n} tier list${n === 1 ? "" : "s"} · ${category.name} · ${day}`;
  body.innerHTML = yesterdayBodyHtml(category, tierStats(category, rows), n);
}

function closeYesterdayDialog() {
  const dialog = $("#yesterday-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function wireYesterdayDialog() {
  const dialog = $("#yesterday-dialog");
  const btn = $("#yesterday-btn");
  if (!dialog || !btn) return;
  btn.addEventListener("click", () => openYesterdayDialog());
  $("#yesterday-dialog-close")?.addEventListener("click", closeYesterdayDialog);
  // A click on the backdrop reports the dialog itself as the target.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeYesterdayDialog();
  });
}

// ---- Tier Lists log (the global feed) ---------------------------------------
// Public tier lists submitted for the day (see submitTierList), newest first.
// Each opens as the same read-only board a comment's "See Tier List" shows.

async function loadTierLists() {
  if (!isConfigured) return;
  const { data, error } = await supabase
    .from("tier_lists")
    .select("day,device_id,author,country,tiers,updated_at,created_at")
    .eq("day", state.today.day)
    .order("updated_at", { ascending: false });
  // A missing table (migration not run yet) just means an empty feed — don't
  // break the rest of the page over it.
  state.tierLists = error ? [] : data || [];
  renderTierLists();
}

function renderTierLists() {
  const log = $("#tierlists-log");
  if (!log) return;
  const entries = state.tierLists;

  $("#tierlist-count").textContent = entries.length;
  $("#tierlists-empty").hidden = entries.length > 0;

  log.innerHTML = "";
  for (const row of entries) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tierlist-row";
    item.innerHTML = `
      <span class="tierlist-who">
        <span class="tierlist-author">${flagPrefix(row.country)}${escapeHtml(row.author || "anon")}</span>
        <span class="tierlist-time">${timeAgo(row.updated_at || row.created_at)}</span>
      </span>
      <span class="tierlist-cta">See Tier List</span>`;
    // The feed shows today's public submissions, so decode against the main
    // forum's category. openTierListDialog reads .tier_list/.author/.country.
    item.addEventListener("click", () =>
      openTierListDialog(mainForum, { tier_list: row.tiers, author: row.author, country: row.country })
    );
    log.appendChild(item);
  }
}

// ---- Suggestions ------------------------------------------------------------
// A suggestion is a comment (kind = "suggestion") whose body is a proposed item.
// Instead of attaching a whole tier list, people give it a single ranking (a tier
// S–F); "See Rankings" opens that distribution + a log of who ranked it where.

// The blurb explaining suggestions is tucked behind the ⓘ widget inside the
// suggest field so it doesn't take up space; clicking it pops the text up.
function wireSuggestInfo() {
  const btn = $("#suggest-info-btn");
  const text = $("#suggest-info-text");
  if (!btn || !text) return;
  btn.addEventListener("click", () => {
    if (infoPopover) closeInfoPopover();
    else showInfoPopover(btn, text.innerHTML);
  });
}

function wireSuggestComposer() {
  const form = $("#suggest-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#suggest-input");
    const errEl = $("#suggest-error");
    errEl.textContent = "";
    const item = input.value.trim().slice(0, 80);
    if (!item) {
      errEl.textContent = "Type an item to suggest.";
      return;
    }
    try {
      await postSuggestion(item);
      input.value = "";
      toast("Suggestion posted");
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

async function postSuggestion(item) {
  // Suggestions only make sense for the live day, so they always post to the
  // main forum (the yesterday forum has no suggest composer).
  const forum = mainForum;
  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null;
  const { data, error } = await supabase
    .from("comments")
    .insert({ day: forum.threadKey(), parent_id: null, author: name, country, body: item, kind: "suggestion", device_id: getVoterId() })
    .select("id,parent_id,author,country,body,tier_list,score,created_at,kind,deleted")
    .single();

  if (error) throw new Error(error.message);

  // The author implicitly upvotes their own suggestion (score starts at 1).
  const votes = store.get(votesKey, {});
  votes[data.id] = 1;
  store.set(votesKey, votes);

  // Remember it's ours so we can offer the delete menu on this device.
  markMine(data.id);

  forum.comments.push(data);
  forum.reactions[data.id] = [];
  renderComments(forum);
}

// ---- Suggestion tier reactions ----------------------------------------------

function reactionsFor(forum, commentId) {
  return forum.reactions[commentId] || [];
}

function reactionCount(forum, commentId) {
  return reactionsFor(forum, commentId).length;
}

function myReactionTier(forum, commentId) {
  const voterId = getVoterId();
  return reactionsFor(forum, commentId).find((r) => r.voter_id === voterId)?.tier || null;
}

function reactBtnLabel(forum, commentId) {
  const tier = myReactionTier(forum, commentId);
  return tier ? `Ranked: ${tier}` : "Vote";
}

function openReactionPicker(forum, anchorBtn, node) {
  const mine = myReactionTier(forum, node.id);
  const grid = TIER_LABELS.map((t) => {
    const cls = `tier-picker-opt${t === mine ? " is-current" : ""}`;
    return `<button type="button" class="${cls}" data-value="${t}" style="background:var(--tier-${t})">${t}</button>`;
  }).join("");

  showMenuPopover(
    anchorBtn,
    `<div class="tier-picker-head">Rank <strong>${escapeHtml(node.body)}</strong></div>
     <div class="tier-picker-grid">${grid}</div>`,
    (tier) => setReaction(forum, node, tier)
  );
}

// Set (or, if you re-pick your current tier, withdraw) this device's reaction.
async function setReaction(forum, node, tier) {
  const voterId = getVoterId();
  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null;

  const list = reactionsFor(forum, node.id);
  const mine = list.find((r) => r.voter_id === voterId);
  const removing = mine && mine.tier === tier;

  // Optimistic update: replace any existing reaction from this device.
  const others = list.filter((r) => r.voter_id !== voterId);
  forum.reactions[node.id] = removing
    ? others
    : [...others, { comment_id: node.id, voter_id: voterId, tier, author: name, country, created_at: new Date().toISOString() }];
  updateSuggestionMeta(forum, node.id);

  const { error } = removing
    ? await supabase.rpc("unreact_suggestion", { c_id: node.id, voter: voterId })
    : await supabase.rpc("react_suggestion", { c_id: node.id, voter: voterId, t: tier, a: name, ctry: country });

  if (error) {
    toast(error.message);
    await reloadReactionsFor(forum, node.id); // resync on failure
    updateSuggestionMeta(forum, node.id);
    return;
  }
  toast(removing ? "Vote removed" : `Ranked ${tier}`);
}

// Re-pull a single suggestion's reactions (used to recover from a failed write).
async function reloadReactionsFor(forum, commentId) {
  const { data, error } = await supabase
    .from("suggestion_reactions")
    .select("comment_id,voter_id,tier,author,country,created_at")
    .eq("comment_id", commentId);
  if (!error) forum.reactions[commentId] = data || [];
}

// Refresh just the count + "Vote"/"Ranked" label on a suggestion in place, so
// reacting doesn't blow away open reply forms elsewhere in the thread.
function updateSuggestionMeta(forum, commentId) {
  const el = $(forum.sel.list)?.querySelector(`.comment[data-id="${commentId}"]`);
  if (!el) return;
  const countEl = el.querySelector('[data-action="votes"] .rcount');
  if (countEl) countEl.textContent = reactionCount(forum, commentId);
  const reactBtn = el.querySelector('[data-action="react"]');
  if (reactBtn) reactBtn.textContent = reactBtnLabel(forum, commentId);
}

// ---- See Rankings dialog -----------------------------------------------------

function openVotesDialog(forum, node) {
  const dialog = $("#votes-dialog");
  if (!dialog) return;

  const reactions = reactionsFor(forum, node.id);
  const counts = Object.fromEntries(TIER_LABELS.map((t) => [t, 0]));
  reactions.forEach((r) => {
    if (counts[r.tier] != null) counts[r.tier] += 1;
  });
  const total = reactions.length;
  const max = Math.max(1, ...TIER_LABELS.map((t) => counts[t]));

  const dist = TIER_LABELS.map((t) => {
    const n = counts[t];
    const pct = Math.round((n / max) * 100);
    return `
      <div class="dist-row">
        <span class="dist-tier" style="background:var(--tier-${t})">${t}</span>
        <span class="dist-bar"><span class="dist-fill" style="width:${pct}%;background:var(--tier-${t})"></span></span>
        <span class="dist-count">${n}</span>
      </div>`;
  }).join("");

  const log = reactions
    .slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .map(
      (r) => `
      <div class="vote-log-row">
        <span class="vote-voter">${flagPrefix(r.country)}${escapeHtml(r.author || "anon")}</span>
        <span class="vote-tier" style="background:var(--tier-${r.tier})">${escapeHtml(r.tier)}</span>
        <span class="vote-time">${r.created_at ? timeAgo(r.created_at) : ""}</span>
      </div>`
    )
    .join("");

  $("#votes-dialog-title").textContent = `Rankings for “${node.body}”`;
  $("#votes-dialog-sub").textContent = `${total} ${total === 1 ? "vote" : "votes"} · ${forum.categoryOf().name}`;
  $("#votes-dialog-body").innerHTML = `
    <div class="dist">${dist}</div>
    ${
      total
        ? `<div class="vote-log"><h3 class="vote-log-title">Who voted</h3>${log}</div>`
        : `<p class="empty">No votes yet. Be the first to vote.</p>`
    }
  `;

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeVotesDialog() {
  const dialog = $("#votes-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function wireVotesDialog() {
  const dialog = $("#votes-dialog");
  if (!dialog) return;
  $("#votes-dialog-close")?.addEventListener("click", closeVotesDialog);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeVotesDialog();
  });
}

function toggleReplyForm(forum, commentEl, parentId) {
  const existing = commentEl.querySelector(":scope > .comment-body > .reply-form");
  if (existing) {
    existing.remove();
    return;
  }
  const form = document.createElement("form");
  form.className = "reply-form";
  form.innerHTML = `
    <textarea class="body-input" rows="2" maxlength="4000" placeholder="Reply…" required></textarea>
    <div class="reply-form-actions">
      <button type="button" class="btn btn-ghost" data-action="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">Reply</button>
    </div>
  `;
  form.querySelector('[data-action="cancel"]').addEventListener("click", () => form.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = form.querySelector(".body-input").value.trim();
    if (!body) return;
    try {
      await postComment(forum, { parentId, body });
      form.remove();
    } catch (err) {
      toast(err.message);
    }
  });

  commentEl.querySelector(".comment-actions").after(form);
  form.querySelector(".body-input").focus();
}

async function vote(forum, id, dir) {
  const votes = store.get(votesKey, {});
  const current = votes[id] || 0;

  const next = dir === 1 ? (current === 1 ? 0 : 1) : current === -1 ? 0 : -1;
  const delta = next - current; // one of -2,-1,1,2 (never 0 here)
  if (delta === 0) return;

  // Optimistic UI update (scoped to this forum's list so the two threads
  // never touch each other's rows).
  const row = $(forum.sel.list)?.querySelector(`.comment[data-id="${id}"]`);
  const scoreEl = row?.querySelector(":scope > .votes > .score");
  const upBtn = row?.querySelector(":scope > .votes > .up");
  const downBtn = row?.querySelector(":scope > .votes > .down");
  if (scoreEl) scoreEl.textContent = Number(scoreEl.textContent) + delta;
  upBtn?.classList.toggle("is-active", next === 1);
  downBtn?.classList.toggle("is-active", next === -1);

  votes[id] = next;
  if (next === 0) delete votes[id];
  store.set(votesKey, votes);

  // vote_comment(c_id, delta) is a controlled RPC that returns the new score.
  const { data, error } = await supabase.rpc("vote_comment", { c_id: id, delta });
  if (error) {
    toast(error.message);
    await loadComments(forum); // resync on failure
    return;
  }
  if (scoreEl) scoreEl.textContent = data;
  const c = forum.comments.find((c) => c.id === id);
  if (c) c.score = data;
}

function wireComposer(forum) {
  const form = $(forum.sel.form);
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const bodyEl = $(forum.sel.body);
    const body = bodyEl.value.trim();
    const errEl = $(forum.sel.error);
    errEl.textContent = "";

    if (!body) {
      errEl.textContent = "Write something first.";
      return;
    }
    try {
      await postComment(forum, { body });
      bodyEl.value = "";
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

async function postComment(forum, { parentId = null, body }) {
  // The author + country come from the on-device profile ("anon" / none unset).
  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null; // ISO alpha-2; shown as a flag by the name
  const day = forum.threadKey();
  // Snapshot the author's saved board for this forum's snapshot day so it can be
  // shown alongside the comment later — for the results forum that's their
  // *yesterday* board, even though the thread key is distinct. Null when nothing
  // is placed (no "See Tier List").
  const placement = store.get(tiersKey(forum.snapshotDay()), {});
  const tierList = encodeTierList(forum.categoryOf(), placement);
  const { data, error } = await supabase
    .from("comments")
    .insert({
      day,
      parent_id: parentId,
      author: name,
      country,
      body,
      tier_list: hasTierList(tierList) ? tierList : null,
      // Stamped so a reply to this comment can be routed back to its author's
      // device for a "reply" notification. Not authenticated — see identity.js.
      device_id: getVoterId()
    })
    .select("id,parent_id,author,country,body,tier_list,score,created_at,kind,deleted")
    .single();

  if (error) throw new Error(error.message);

  // The author implicitly upvotes their own comment (score starts at 1).
  const votes = store.get(votesKey, {});
  votes[data.id] = 1;
  store.set(votesKey, votes);

  // Remember it's ours so we can offer the delete menu on this device.
  markMine(data.id);

  forum.comments.push(data);
  renderComments(forum);
}

function wireSortToggle(forum) {
  const root = $(forum.sel.root);
  if (!root) return;
  root.querySelectorAll(".sort-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".sort-opt").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      forum.sort = btn.dataset.sort;
      renderComments(forum);
    });
  });
}
