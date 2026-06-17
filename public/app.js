// sabcdef client. Plain ES modules, no build step.
// SortableJS is loaded globally from the CDN <script> in index.html.
import { CATEGORIES } from "./categories.js";
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
  sort: "top"
};

const tiersKey = (day) => `sabcdef:tiers:${day}`;
const votesKey = "sabcdef:votes";
const authorKey = "sabcdef:author";
const themeKey = "sabcdef:theme";

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

function getToday() {
  const day = dayString();
  const epochDays = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const index = ((epochDays % CATEGORIES.length) + CATEGORIES.length) % CATEGORIES.length;
  const cat = CATEGORIES[index];
  return { day, index, name: cat.name, blurb: cat.blurb, items: cat.items, tierLabels: TIER_LABELS };
}

// ---- Boot -----------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  $("#category-name").textContent = "Something went wrong loading the app.";
  $("#category-blurb").textContent = err.message;
});

async function init() {
  wireThemeToggle(); // independent of everything else

  state.today = getToday();
  renderCategoryHead();
  renderTierList();
  wireToolbar();
  wireChipPicker();

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

// ---- Category header ------------------------------------------------------

function renderCategoryHead() {
  const { day, name, blurb } = state.today;
  $("#category-name").textContent = name;
  $("#category-blurb").textContent = blurb || "";
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

  // Restore saved placements; anything unplaced goes to the pool.
  const saved = store.get(tiersKey(day), {}); // { itemId: tierLabel }
  poolEl.innerHTML = "";

  for (const item of items) {
    const chip = makeChip(item);
    const tier = saved[item.id];
    const target = tier && tier !== "pool" ? $(`.tier-dropzone[data-tier="${tier}"]`) : poolEl;
    (target || poolEl).appendChild(chip);
  }

  initSortable();
}

function makeChip(item) {
  const chip = document.createElement("div");
  chip.className = "chip";
  chip.dataset.id = item.id;
  chip.title = item.name;
  // Also operable by tap/click and keyboard (Enter/Space), not just dragging.
  chip.tabIndex = 0;
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-label", `${item.name} — tap to assign a tier`);
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
    const chip = e.target.closest(".chip");
    if (!chip) return;
    // Skip the click SortableJS may synthesize at the end of a drag.
    if (Date.now() - lastDragEndAt < 250) return;
    openTierPicker(chip);
  });

  section.addEventListener("keydown", (e) => {
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

  $("#share-btn").addEventListener("click", async () => {
    const text = buildShareText();
    try {
      await navigator.clipboard.writeText(text);
      toast("Ranking copied to clipboard");
    } catch {
      toast("Couldn't copy — clipboard blocked");
    }
  });
}

function buildShareText() {
  const { name, day, tierLabels } = state.today;
  const byId = Object.fromEntries(state.today.items.map((i) => [i.id, i]));
  const placement = store.get(tiersKey(day), {});
  const lines = [`sabcdef — ${name} (${day})`];
  for (const label of tierLabels) {
    const names = Object.entries(placement)
      .filter(([, t]) => t === label)
      .map(([id]) => byId[id]?.name)
      .filter(Boolean);
    if (names.length) lines.push(`${label}: ${names.join(", ")}`);
  }
  return lines.join("\n");
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
    .select("id,parent_id,author,body,score,created_at")
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
        <span class="comment-author">${escapeHtml(node.author)}</span>
        <span class="comment-time">${timeAgo(node.created_at)}</span>
      </div>
      <div class="comment-text">${escapeHtml(node.body)}</div>
      <div class="comment-actions">
        <button class="reply-btn" data-action="reply">Reply</button>
      </div>
    </div>
  `;

  el.querySelector(".vote-btn.up").addEventListener("click", () => vote(node.id, 1));
  el.querySelector(".vote-btn.down").addEventListener("click", () => vote(node.id, -1));
  el.querySelector('[data-action="reply"]').addEventListener("click", () => toggleReplyForm(el, node.id));

  if (node.children.length) {
    const thread = document.createElement("div");
    // Cap visual indentation so deep chains don't run off a phone screen.
    thread.className = depth < 5 ? "comment-thread" : "";
    node.children.forEach((child) => thread.appendChild(renderNode(child, votes, depth + 1)));
    el.querySelector(".comment-body").appendChild(thread);
  }
  return el;
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
  const authorInput = $("#author-input");
  authorInput.value = store.get(authorKey, "") || "";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = $("#body-input").value.trim();
    const author = authorInput.value.trim();
    const errEl = $("#composer-error");
    errEl.textContent = "";

    if (!body) {
      errEl.textContent = "Write something first.";
      return;
    }
    store.set(authorKey, author);
    try {
      await postComment({ author, body });
      $("#body-input").value = "";
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

async function postComment({ parentId = null, author, body }) {
  const name = ((author ?? store.get(authorKey, "")) || "").trim().slice(0, 32) || "anon";
  const { data, error } = await supabase
    .from("comments")
    .insert({ day: state.today.day, parent_id: parentId, author: name, body })
    .select("id,parent_id,author,body,score,created_at")
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
