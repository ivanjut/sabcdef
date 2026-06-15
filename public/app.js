// sabcdef client. Plain ES modules, no build step.
// SortableJS is loaded globally from the CDN <script> in index.html.

const $ = (sel, root = document) => root.querySelector(sel);

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

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
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
  today: null, // { day, name, blurb, items, tierLabels, ... }
  comments: [], // flat list from server
  sort: "top"
};

const tiersKey = (day) => `sabcdef:tiers:${day}`;
const votesKey = "sabcdef:votes";
const authorKey = "sabcdef:author";
const themeKey = "sabcdef:theme";

// ---- Boot -----------------------------------------------------------------

init().catch((err) => {
  console.error(err);
  $("#category-name").textContent = "Couldn't load today's category.";
  $("#category-blurb").textContent = err.message;
});

async function init() {
  wireThemeToggle(); // before the await so it works even if the API call fails
  state.today = await api("/api/today");
  renderCategoryHead();
  renderTierList();
  wireToolbar();

  await loadComments();
  wireComposer();
  wireSortToggle();
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

// ---- Tier list ------------------------------------------------------------

function renderTierList() {
  const { day, items, tierLabels } = state.today;
  const tiersEl = $("#tiers");
  const poolEl = $("#pool");
  tiersEl.innerHTML = "";

  // Map of tierLabel -> hex var, falls back to neutral.
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
      delay: 120, // small hold so page scrolling still works on touch
      delayOnTouchOnly: true,
      touchStartThreshold: 4,
      onSort: saveTierPlacements
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

// ---- Forum ----------------------------------------------------------------

async function loadComments() {
  const data = await api(`/api/comments?day=${encodeURIComponent(state.today.day)}`);
  state.comments = data.comments;
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

  // Vote handlers
  el.querySelector(".vote-btn.up").addEventListener("click", () => vote(node.id, 1));
  el.querySelector(".vote-btn.down").addEventListener("click", () => vote(node.id, -1));
  el.querySelector('[data-action="reply"]').addEventListener("click", () => toggleReplyForm(el, node.id));

  // Children
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
    await postComment({ parentId, body });
    form.remove();
  });

  commentEl.querySelector(".comment-actions").after(form);
  form.querySelector(".body-input").focus();
}

async function vote(id, dir) {
  const votes = store.get(votesKey, {});
  const current = votes[id] || 0;

  let next, delta;
  if (dir === 1) {
    next = current === 1 ? 0 : 1;
  } else {
    next = current === -1 ? 0 : -1;
  }
  delta = next - current; // one of -2,-1,1,2 (never 0 here)
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

  try {
    const res = await api(`/api/comments/${id}/vote`, {
      method: "POST",
      body: JSON.stringify({ dir: delta })
    });
    // Reconcile with authoritative score and keep our flat copy in sync.
    if (scoreEl) scoreEl.textContent = res.score;
    const c = state.comments.find((c) => c.id === id);
    if (c) c.score = res.score;
  } catch (err) {
    toast(err.message);
    await loadComments(); // resync on failure
  }
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
  const savedAuthor = author ?? store.get(authorKey, "");
  const created = await api("/api/comments", {
    method: "POST",
    body: JSON.stringify({
      day: state.today.day,
      parentId,
      author: savedAuthor,
      body
    })
  });
  // The author implicitly upvotes their own comment (score starts at 1).
  const votes = store.get(votesKey, {});
  votes[created.id] = 1;
  store.set(votesKey, votes);

  state.comments.push(created);
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
