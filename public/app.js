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
function toast(msg) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
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
  comments: [], // flat list from Supabase
  reactions: {}, // { suggestionCommentId: [ { voter_id, tier, author, country, created_at } ] }
  tierLists: [], // public submissions for the day (the global feed), newest first
  sort: "top",
  // When the page is opened from a share link, we render someone else's tiers
  // read-only instead of the local game.
  readOnly: false,
  preview: null, // { itemId: tierLabel } decoded from the share link
  previewAuthor: "", // sharer's display name, from the share link
  previewCountry: "" // sharer's ISO alpha-2 country code, from the share link
};

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
  wireShareMenu();
  wireChipPicker();
  wireTierListDialog();
  wireVotesDialog();
  wireSuggestInfo();
  startCountdown();

  // First visit (no profile saved on this device): prompt for name + country.
  // Skipped when viewing someone else's shared tier list.
  if (!previewing && !getProfile()) openProfileDialog("onboarding");

  if (isConfigured) {
    wireComposer();
    wireSuggestComposer();
    wireSortToggle();
    await loadComments();
    await loadTierLists();
  } else {
    showForumOffline();
  }

  // Push notifications (daily category + new comments). Self-contained: it
  // reveals the header bell only when supported + configured, and never blocks
  // the rest of the app if it fails.
  initPush().catch((err) => console.error("Push init failed:", err));
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
  populateCountrySelect();
  renderProfile();

  $("#profile-btn").addEventListener("click", () => openProfileDialog("edit"));
  // The composer's "Posting as <name>" is also a shortcut into the editor.
  $("#composer-identity-btn")?.addEventListener("click", () => openProfileDialog("edit"));

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

function populateCountrySelect() {
  const select = $("#profile-country-input");
  if (!select) return;
  const frag = document.createDocumentFragment();
  for (const c of COUNTRIES) {
    const opt = document.createElement("option");
    opt.value = c.code;
    opt.textContent = `${flagEmoji(c.code)} ${c.name}`;
    frag.appendChild(opt);
  }
  select.appendChild(frag);
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
  const idBtn = $("#composer-identity-btn");
  if (idBtn) idBtn.textContent = `${flagPrefix(profile.country)}${name || "anon"}`;
}

function openProfileDialog(mode = "edit") {
  const dialog = $("#profile-dialog");
  const profile = getProfile() || {};
  const onboarding = mode === "onboarding";

  $("#profile-name-input").value = profile.name || "";
  $("#profile-country-input").value = profile.country || "";
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
  const { day, name } = state.today;
  $("#category-name").textContent = name;
  $("#today-date").textContent = new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
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
  updateSubmitAttention();
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

  document.body.append(backdrop, picker);
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

  document.body.append(backdrop, pop);
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

// Pulse the Submit button when the board is full *and* differs from what this
// device last submitted — i.e. there's something new worth submitting. Cleared
// after a submit, or whenever items are still unranked.
function updateSubmitAttention() {
  const btn = $("#submit-btn");
  if (!btn || state.readOnly) return;
  const enc = encodeTierList(state.today, store.get(tiersKey(state.today.day), {}));
  const lastSubmitted = store.get(submittedKey(state.today.day), null);
  btn.classList.toggle("is-ready", poolIsEmpty() && enc !== lastSubmitted);
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
  if (state.readOnly || !isConfigured) return;
  const btn = $("#submit-btn");
  btn.disabled = true;
  try {
    const res = await persistTierList();
    if (!res.ok) {
      toast(res.reason === "empty" ? "Rank at least one item first." : res.error?.message || "Couldn't submit your tier list");
      return;
    }
    await loadTierLists(); // resync the feed from the server (also re-renders)
    updateSubmitAttention();
    toast(res.visibility === "public" ? "Tier list submitted to the global feed" : "Submitted privately — not shown on the feed");
  } catch (err) {
    toast(err.message || "Couldn't submit your tier list");
  } finally {
    btn.disabled = false;
  }
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

async function loadComments() {
  const { data, error } = await supabase
    .from("comments")
    .select("id,parent_id,author,country,body,tier_list,score,created_at,kind")
    .eq("day", state.today.day)
    .order("created_at", { ascending: true });

  if (error) {
    $("#comments-empty").hidden = false;
    $("#comments-empty").textContent = `Couldn't load the discussion: ${error.message}`;
    return;
  }
  state.comments = data || [];
  const suggestionIds = state.comments.filter((c) => c.kind === "suggestion").map((c) => c.id);
  await loadReactions(suggestionIds);
  renderComments();
}

// Pull the tier reactions for the day's suggestions, grouped by comment id.
async function loadReactions(commentIds) {
  state.reactions = {};
  if (!commentIds.length) return;
  const { data, error } = await supabase
    .from("suggestion_reactions")
    .select("comment_id,voter_id,tier,author,country,created_at")
    .in("comment_id", commentIds);
  if (error) return; // reactions are non-essential; the discussion still loads
  for (const r of data || []) (state.reactions[r.comment_id] ||= []).push(r);
}

function buildTree(flat) {
  const nodes = new Map();
  flat.forEach((c) => nodes.set(c.id, { ...c, children: [] }));
  const roots = [];
  nodes.forEach((node) => {
    if (node.parent_id != null && nodes.has(node.parent_id)) {
      nodes.get(node.parent_id).children.push(node);
    } else {
      roots.push(node);
    }
  });

  const cmp =
    state.sort === "top"
      ? (a, b) => b.score - a.score || a.created_at.localeCompare(b.created_at)
      : (a, b) => b.created_at.localeCompare(a.created_at);

  const sortRec = (list) => {
    list.sort(cmp);
    list.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

function renderComments() {
  const container = $("#comments");
  const roots = buildTree(state.comments);

  $("#comment-count").textContent = state.comments.length;
  $("#comments-empty").hidden = state.comments.length > 0;
  if (!state.comments.length) $("#comments-empty").textContent = "No comments yet. Start the debate.";

  container.innerHTML = "";
  const votes = store.get(votesKey, {});
  roots.forEach((node) => container.appendChild(renderNode(node, votes, 0)));
}

function renderNode(node, votes, depth) {
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

  // Suggestions get a badge + a prominent item name, and a "Vote" button that
  // ranks the item into a tier, plus a "See Rankings" breakdown of those votes.
  // Everything else (score, reply) works the same as a normal comment.
  const text = isSuggestion
    ? `<div class="comment-text"><span class="suggest-item">${escapeHtml(node.body)}</span></div>`
    : `<div class="comment-text">${escapeHtml(node.body)}</div>`;

  const actions = isSuggestion
    ? `<button class="reply-btn" data-action="reply">Reply</button>
       <button class="react-btn" data-action="react">${reactBtnLabel(node.id)}</button>
       <button class="ranking-btn" data-action="votes">See Rankings <span class="rcount">${reactionCount(node.id)}</span></button>`
    : `<button class="reply-btn" data-action="reply">Reply</button>
       ${hasTierList(node.tier_list) ? `<button class="ranking-btn" data-action="tierlist">See Tier List</button>` : ""}`;

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
      </div>
      ${text}
      <div class="comment-actions">${actions}</div>
    </div>
  `;

  el.querySelector(".vote-btn.up").addEventListener("click", () => vote(node.id, 1));
  el.querySelector(".vote-btn.down").addEventListener("click", () => vote(node.id, -1));
  el.querySelector('[data-action="reply"]').addEventListener("click", () => toggleReplyForm(el, node.id));
  el.querySelector('[data-action="tierlist"]')?.addEventListener("click", () => openTierListDialog(node));
  el.querySelector('[data-action="react"]')?.addEventListener("click", (e) => openReactionPicker(e.currentTarget, node));
  el.querySelector('[data-action="votes"]')?.addEventListener("click", () => openVotesDialog(node));

  wrapper.appendChild(el);

  if (node.children.length) {
    const thread = document.createElement("div");
    // Cap visual indentation so deep chains don't run off a phone screen.
    thread.className = depth < 5 ? "comment-thread" : "";
    node.children.forEach((child) => thread.appendChild(renderNode(child, votes, depth + 1)));
    wrapper.appendChild(thread);
  }
  return wrapper;
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

function openTierListDialog(node) {
  const dialog = $("#tierlist-dialog");
  if (!dialog) return;
  // Comments are loaded for the current day, so state.today is the right
  // category to decode the positional tier list against.
  const placement = decodeTierList(state.today, node.tier_list);

  $("#tierlist-dialog-title").textContent = `${flagPrefix(node.country)}${node.author || "anon"}'s tier list`;
  $("#tierlist-dialog-sub").textContent = `${state.today.name} · ${state.today.day}`;
  $("#tierlist-dialog-body").innerHTML = tierListHtml(state.today, placement);

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
    // openTierListDialog reads .tier_list/.author/.country — adapt the feed row.
    item.addEventListener("click", () =>
      openTierListDialog({ tier_list: row.tiers, author: row.author, country: row.country })
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
  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null;
  const { data, error } = await supabase
    .from("comments")
    .insert({ day: state.today.day, parent_id: null, author: name, country, body: item, kind: "suggestion", device_id: getVoterId() })
    .select("id,parent_id,author,country,body,tier_list,score,created_at,kind")
    .single();

  if (error) throw new Error(error.message);

  // The author implicitly upvotes their own suggestion (score starts at 1).
  const votes = store.get(votesKey, {});
  votes[data.id] = 1;
  store.set(votesKey, votes);

  state.comments.push(data);
  state.reactions[data.id] = [];
  renderComments();
}

// ---- Suggestion tier reactions ----------------------------------------------

function reactionsFor(commentId) {
  return state.reactions[commentId] || [];
}

function reactionCount(commentId) {
  return reactionsFor(commentId).length;
}

function myReactionTier(commentId) {
  const voterId = getVoterId();
  return reactionsFor(commentId).find((r) => r.voter_id === voterId)?.tier || null;
}

function reactBtnLabel(commentId) {
  const tier = myReactionTier(commentId);
  return tier ? `Ranked: ${tier}` : "Vote";
}

function openReactionPicker(anchorBtn, node) {
  const mine = myReactionTier(node.id);
  const grid = TIER_LABELS.map((t) => {
    const cls = `tier-picker-opt${t === mine ? " is-current" : ""}`;
    return `<button type="button" class="${cls}" data-value="${t}" style="background:var(--tier-${t})">${t}</button>`;
  }).join("");

  showMenuPopover(
    anchorBtn,
    `<div class="tier-picker-head">Rank <strong>${escapeHtml(node.body)}</strong></div>
     <div class="tier-picker-grid">${grid}</div>`,
    (tier) => setReaction(node, tier)
  );
}

// Set (or, if you re-pick your current tier, withdraw) this device's reaction.
async function setReaction(node, tier) {
  const voterId = getVoterId();
  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null;

  const list = reactionsFor(node.id);
  const mine = list.find((r) => r.voter_id === voterId);
  const removing = mine && mine.tier === tier;

  // Optimistic update: replace any existing reaction from this device.
  const others = list.filter((r) => r.voter_id !== voterId);
  state.reactions[node.id] = removing
    ? others
    : [...others, { comment_id: node.id, voter_id: voterId, tier, author: name, country, created_at: new Date().toISOString() }];
  updateSuggestionMeta(node.id);

  const { error } = removing
    ? await supabase.rpc("unreact_suggestion", { c_id: node.id, voter: voterId })
    : await supabase.rpc("react_suggestion", { c_id: node.id, voter: voterId, t: tier, a: name, ctry: country });

  if (error) {
    toast(error.message);
    await reloadReactionsFor(node.id); // resync on failure
    updateSuggestionMeta(node.id);
    return;
  }
  toast(removing ? "Vote removed" : `Ranked ${tier}`);
}

// Re-pull a single suggestion's reactions (used to recover from a failed write).
async function reloadReactionsFor(commentId) {
  const { data, error } = await supabase
    .from("suggestion_reactions")
    .select("comment_id,voter_id,tier,author,country,created_at")
    .eq("comment_id", commentId);
  if (!error) state.reactions[commentId] = data || [];
}

// Refresh just the count + "Vote"/"Ranked" label on a suggestion in place, so
// reacting doesn't blow away open reply forms elsewhere in the thread.
function updateSuggestionMeta(commentId) {
  const el = document.querySelector(`.comment[data-id="${commentId}"]`);
  if (!el) return;
  const countEl = el.querySelector('[data-action="votes"] .rcount');
  if (countEl) countEl.textContent = reactionCount(commentId);
  const reactBtn = el.querySelector('[data-action="react"]');
  if (reactBtn) reactBtn.textContent = reactBtnLabel(commentId);
}

// ---- See Rankings dialog -----------------------------------------------------

function openVotesDialog(node) {
  const dialog = $("#votes-dialog");
  if (!dialog) return;

  const reactions = reactionsFor(node.id);
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
  $("#votes-dialog-sub").textContent = `${total} ${total === 1 ? "vote" : "votes"} · ${state.today.name}`;
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

function toggleReplyForm(commentEl, parentId) {
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
      await postComment({ parentId, body });
      form.remove();
    } catch (err) {
      toast(err.message);
    }
  });

  commentEl.querySelector(".comment-actions").after(form);
  form.querySelector(".body-input").focus();
}

async function vote(id, dir) {
  const votes = store.get(votesKey, {});
  const current = votes[id] || 0;

  const next = dir === 1 ? (current === 1 ? 0 : 1) : current === -1 ? 0 : -1;
  const delta = next - current; // one of -2,-1,1,2 (never 0 here)
  if (delta === 0) return;

  // Optimistic UI update
  const row = document.querySelector(`.comment[data-id="${id}"]`);
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
    await loadComments(); // resync on failure
    return;
  }
  if (scoreEl) scoreEl.textContent = data;
  const c = state.comments.find((c) => c.id === id);
  if (c) c.score = data;
}

function wireComposer() {
  const form = $("#comment-form");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("#body-input").value.trim();
    const errEl = $("#composer-error");
    errEl.textContent = "";

    if (!body) {
      errEl.textContent = "Write something first.";
      return;
    }
    try {
      await postComment({ body });
      $("#body-input").value = "";
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

async function postComment({ parentId = null, body }) {
  // The author + country come from the on-device profile ("anon" / none unset).
  const profile = getProfile() || {};
  const name = (profile.name || "").trim().slice(0, 32) || "anon";
  const country = profile.country || null; // ISO alpha-2; shown as a flag by the name
  // Snapshot the author's current tier list so it can be shown alongside the
  // comment later. Stored null when nothing is placed yet (no "See Tier List").
  const placement = store.get(tiersKey(state.today.day), {});
  const tierList = encodeTierList(state.today, placement);
  const { data, error } = await supabase
    .from("comments")
    .insert({
      day: state.today.day,
      parent_id: parentId,
      author: name,
      country,
      body,
      tier_list: hasTierList(tierList) ? tierList : null,
      // Stamped so a reply to this comment can be routed back to its author's
      // device for a "reply" notification. Not authenticated — see identity.js.
      device_id: getVoterId()
    })
    .select("id,parent_id,author,country,body,tier_list,score,created_at,kind")
    .single();

  if (error) throw new Error(error.message);

  // The author implicitly upvotes their own comment (score starts at 1).
  const votes = store.get(votesKey, {});
  votes[data.id] = 1;
  store.set(votesKey, votes);

  state.comments.push(data);
  renderComments();
}

function wireSortToggle() {
  document.querySelectorAll(".sort-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sort-opt").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.sort = btn.dataset.sort;
      renderComments();
    });
  });
}
