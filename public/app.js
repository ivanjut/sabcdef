// sabcdef client. Plain ES modules, no build step.
// SortableJS is loaded globally from the CDN <script> in index.html.
import { CATEGORIES } from "./categories.js";
import { COUNTRIES, flagEmoji } from "./countries.js";
import { supabase, isConfigured } from "./supabase.js";

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
  today: null, // { day, name, blurb, items, tierLabels }
  comments: [], // flat list from Supabase
  sort: "top",
  // When the page is opened from a share link, we render someone else's tiers
  // read-only instead of the local game.
  readOnly: false,
  preview: null, // { itemId: tierLabel } decoded from the share link
  previewAuthor: "", // sharer's display name, from the share link
  previewCountry: "" // sharer's ISO alpha-2 country code, from the share link
};

const tiersKey = (day) => `sabcdef:tiers:${day}`;
const votesKey = "sabcdef:votes";
const themeKey = "sabcdef:theme";
const profileKey = "sabcdef:profile"; // { name, country } — country is an ISO alpha-2 code

// Timestamp of the most recent drag end, so the synthetic click SortableJS may
// fire afterwards doesn't pop open the tap-to-assign picker.
let lastDragEndAt = 0;

// ---- Daily category (computed client-side) --------------------------------
// "Today" is the visitor's local date as YYYY-MM-DD. The category is chosen by
// the number of whole days since the Unix epoch, modulo the category count, so
// the choice is stable for everyone on a given day and rotates predictably.

function dayString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function categoryForDay(day) {
  const epochDays = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const index = ((epochDays % CATEGORIES.length) + CATEGORIES.length) % CATEGORIES.length;
  const cat = CATEGORIES[index];
  return { day, index, name: cat.name, blurb: cat.blurb, items: cat.items, tierLabels: TIER_LABELS };
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

  const shared = getShareParams();
  if (shared && CATEGORIES.length) {
    enterPreview(shared);
  } else {
    state.today = getToday();
    renderCategoryHead();
    renderTierList();
  }

  wireToolbar();
  wireShareMenu();
  wireChipPicker();
  wireRankingDialog();

  // First visit (no profile saved on this device): prompt for name + country.
  // Skipped when viewing someone else's shared ranking.
  if (!shared && !getProfile()) openProfileDialog("onboarding");

  if (isConfigured) {
    wireComposer();
    wireSortToggle();
    await loadComments();
  } else {
    showForumOffline();
  }
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
  store.set(profileKey, { name: profile.name || "", country: profile.country || "" });
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
      country: $("#profile-country-input").value
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
  // this device's saved ranking. Anything unplaced goes to the pool.
  const saved = state.readOnly ? state.preview || {} : store.get(tiersKey(day), {}); // { itemId: tierLabel }
  poolEl.innerHTML = "";

  for (const item of items) {
    const chip = makeChip(item);
    const tier = saved[item.id];
    const target = tier && tier !== "pool" ? $(`.tier-dropzone[data-tier="${tier}"]`) : poolEl;
    (target || poolEl).appendChild(chip);
  }

  if (!state.readOnly) initSortable();
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
      onStart: closeTierPicker,
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
}

// ---- Tap / click to assign --------------------------------------------------
// As an alternative to dragging, tapping a chip opens a small popover of tiers;
// picking one moves the chip there. Wired once via delegation on the (stable)
// tier-list section, so it survives re-renders from Reset.

let pickerEls = null;

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
  closeTierPicker();

  const item = state.today.items.find((i) => i.id === chip.dataset.id);
  const current = currentTierOf(chip);
  const opts = [...state.today.tierLabels, "pool"];

  const backdrop = document.createElement("div");
  backdrop.className = "tier-picker-backdrop";

  const picker = document.createElement("div");
  picker.className = "tier-picker";
  picker.setAttribute("role", "menu");
  picker.innerHTML = `
    <div class="tier-picker-head">Assign <strong>${escapeHtml(item?.name || "")}</strong></div>
    <div class="tier-picker-grid">
      ${opts
        .map((t) => {
          const isPool = t === "pool";
          const cls = `tier-picker-opt${isPool ? " is-pool" : ""}${t === current ? " is-current" : ""}`;
          const style = isPool ? "" : ` style="background:var(--tier-${t})"`;
          return `<button type="button" class="${cls}" data-tier="${t}"${style}>${isPool ? "Unranked" : t}</button>`;
        })
        .join("")}
    </div>
  `;

  document.body.append(backdrop, picker);
  positionPicker(picker, chip);

  backdrop.addEventListener("click", closeTierPicker);
  picker.addEventListener("click", (e) => {
    const btn = e.target.closest(".tier-picker-opt");
    if (!btn) return;
    assignChipToTier(chip, btn.dataset.tier);
    closeTierPicker();
  });

  const onKey = (e) => {
    if (e.key === "Escape") closeTierPicker();
  };
  document.addEventListener("keydown", onKey);
  // The picker is anchored to the chip; if the page moves, just dismiss it.
  window.addEventListener("scroll", closeTierPicker, true);
  window.addEventListener("resize", closeTierPicker);

  pickerEls = { backdrop, picker, onKey };
  picker.querySelector(".tier-picker-opt")?.focus();
}

function closeTierPicker() {
  if (!pickerEls) return;
  const { backdrop, picker, onKey } = pickerEls;
  document.removeEventListener("keydown", onKey);
  window.removeEventListener("scroll", closeTierPicker, true);
  window.removeEventListener("resize", closeTierPicker);
  backdrop.remove();
  picker.remove();
  pickerEls = null;
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
    toast("Ranking reset");
  });
}

// ---- Share ------------------------------------------------------------------
// The "Share" button opens a small menu with two options:
//   1. Share link — a URL that, when opened, shows the sharer's tiers as a
//      read-only preview. Placements are encoded positionally into the URL so
//      no backend is needed (this is a static site).
//   2. Copy ranking — the existing plain-text summary.

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
    else copyRankingText();
  });
}

async function shareLink() {
  const url = buildShareUrl();
  // Prefer the native share sheet where available (mobile, some desktops).
  if (navigator.share) {
    try {
      await navigator.share({ title: "Tier Drop", text: `My ${state.today.name} tier ranking`, url });
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

async function copyRankingText() {
  try {
    await navigator.clipboard.writeText(buildShareText());
    toast("Ranking copied to clipboard");
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

// Encode placements positionally: one char per item (in category order), using
// the tier letter or "-" for unranked. Compact and stable for a given day.
function encodeRanking(today, placement) {
  return today.items.map((item) => (TIER_LABELS.includes(placement[item.id]) ? placement[item.id] : "-")).join("");
}

function decodeRanking(today, str) {
  const chars = String(str || "").split("");
  const placement = {};
  today.items.forEach((item, i) => {
    const c = chars[i];
    if (c && TIER_LABELS.includes(c)) placement[item.id] = c;
  });
  return placement;
}

// True when an encoded ranking places at least one item into a tier (i.e. it's
// not all "-" / empty). Used to decide whether to offer "See Ranking".
function hasRanking(str) {
  return Boolean(str) && [...str].some((c) => TIER_LABELS.includes(c));
}

// A country flag + trailing space to prefix a name with, or "" when there's no
// country. flagEmoji only ever returns safe regional-indicator codepoints, so
// the result is safe to drop into innerHTML.
function flagPrefix(country) {
  const flag = flagEmoji(country);
  return flag ? `${flag} ` : "";
}

function buildShareUrl() {
  const placement = store.get(tiersKey(state.today.day), {});
  const profile = getProfile() || {};
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("d", state.today.day);
  url.searchParams.set("r", encodeRanking(state.today, placement));
  // Carry the sharer's display name + country so the preview can attribute it.
  const name = (profile.name || "").trim().slice(0, 32);
  if (name) url.searchParams.set("n", name);
  if (profile.country) url.searchParams.set("c", profile.country);
  return url.toString();
}

function getShareParams() {
  const params = new URLSearchParams(location.search);
  const day = params.get("d");
  const ranking = params.get("r");
  // Day must look like YYYY-MM-DD; otherwise ignore and load the normal game.
  if (day && ranking != null && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { day, ranking, name: params.get("n") || "", country: params.get("c") || "" };
  }
  return null;
}

// ---- Shared-ranking preview -------------------------------------------------

function enterPreview({ day, ranking, name, country }) {
  state.today = categoryForDay(day);
  state.readOnly = true;
  state.preview = decodeRanking(state.today, ranking);
  state.previewAuthor = (name || "").trim().slice(0, 32);
  state.previewCountry = country || "";
  document.body.classList.add("preview-mode");
  renderCategoryHead();
  renderPreviewBanner();
  renderTierList();
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
    <span class="preview-text">You're viewing ${who} <strong>${escapeHtml(state.today.name)}</strong> ranking.</span>
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
  $("#comment-count").textContent = "0";
}

async function loadComments() {
  const { data, error } = await supabase
    .from("comments")
    .select("id,parent_id,author,country,body,ranking,score,created_at")
    .eq("day", state.today.day)
    .order("created_at", { ascending: true });

  if (error) {
    $("#comments-empty").hidden = false;
    $("#comments-empty").textContent = `Couldn't load the discussion: ${error.message}`;
    return;
  }
  state.comments = data || [];
  renderComments();
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

  // A node is a comment plus (optionally) the thread of its replies. The thread
  // is a sibling of the comment — not nested inside its body — so the reply line
  // lines up with the left edge of the comment instead of its text column.
  const wrapper = document.createElement("div");
  wrapper.className = "comment-node";

  const el = document.createElement("div");
  el.className = "comment";
  el.dataset.id = node.id;
  el.innerHTML = `
    <div class="votes">
      <button class="vote-btn up ${myVote === 1 ? "is-active" : ""}" data-dir="up" aria-label="Upvote">▲</button>
      <span class="score">${node.score}</span>
      <button class="vote-btn down ${myVote === -1 ? "is-active" : ""}" data-dir="down" aria-label="Downvote">▼</button>
    </div>
    <div class="comment-body">
      <div class="comment-meta">
        <span class="comment-author">${flagPrefix(node.country)}${escapeHtml(node.author)}</span>
        <span class="comment-time">${timeAgo(node.created_at)}</span>
      </div>
      <div class="comment-text">${escapeHtml(node.body)}</div>
      <div class="comment-actions">
        <button class="reply-btn" data-action="reply">Reply</button>
        ${hasRanking(node.ranking) ? `<button class="ranking-btn" data-action="ranking">See Ranking</button>` : ""}
      </div>
    </div>
  `;

  el.querySelector(".vote-btn.up").addEventListener("click", () => vote(node.id, 1));
  el.querySelector(".vote-btn.down").addEventListener("click", () => vote(node.id, -1));
  el.querySelector('[data-action="reply"]').addEventListener("click", () => toggleReplyForm(el, node.id));
  el.querySelector('[data-action="ranking"]')?.addEventListener("click", () => openRankingDialog(node));

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

// ---- Comment ranking popup -------------------------------------------------
// Each comment carries a snapshot of its author's tier ranking at post time
// (see postComment). "See Ranking" opens a read-only visual of it in a dialog.

function rankingTiersHtml(today, placement) {
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

function openRankingDialog(node) {
  const dialog = $("#ranking-dialog");
  if (!dialog) return;
  // Comments are loaded for the current day, so state.today is the right
  // category to decode the positional ranking against.
  const placement = decodeRanking(state.today, node.ranking);

  $("#ranking-dialog-title").textContent = `${flagPrefix(node.country)}${node.author || "anon"}'s ranking`;
  $("#ranking-dialog-sub").textContent = `${state.today.name} · ${state.today.day}`;
  $("#ranking-dialog-body").innerHTML = rankingTiersHtml(state.today, placement);

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeRankingDialog() {
  const dialog = $("#ranking-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function wireRankingDialog() {
  const dialog = $("#ranking-dialog");
  if (!dialog) return;
  $("#ranking-dialog-close")?.addEventListener("click", closeRankingDialog);
  // A click on the backdrop reports the dialog itself as the target.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeRankingDialog();
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
  // Snapshot the author's current tier ranking so it can be shown alongside the
  // comment later. Stored null when nothing is placed yet (no "See Ranking").
  const placement = store.get(tiersKey(state.today.day), {});
  const ranking = encodeRanking(state.today, placement);
  const { data, error } = await supabase
    .from("comments")
    .insert({
      day: state.today.day,
      parent_id: parentId,
      author: name,
      country,
      body,
      ranking: hasRanking(ranking) ? ranking : null
    })
    .select("id,parent_id,author,country,body,ranking,score,created_at")
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
