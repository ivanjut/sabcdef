import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./data/categories.js";
import {
  addComment,
  getCommentsForDay,
  commentExists,
  voteComment,
  countForDay
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---- Daily category selection --------------------------------------------
// "Today" is the server's local date as YYYY-MM-DD. The category is chosen by
// the number of whole days since the Unix epoch, modulo the category count, so
// the choice is stable for everyone on a given day and rotates predictably.

function dayString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function categoryForDay(day) {
  // Parse as UTC midnight so the index is independent of server timezone.
  const epochDays = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const index = ((epochDays % CATEGORIES.length) + CATEGORIES.length) % CATEGORIES.length;
  return { day, index, ...CATEGORIES[index] };
}

const isValidDay = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ---- API ------------------------------------------------------------------

app.get("/api/today", (req, res) => {
  const day = dayString();
  const category = categoryForDay(day);
  res.json({
    ...category,
    commentCount: countForDay(day),
    tierLabels: ["S", "A", "B", "C", "D", "E", "F"]
  });
});

app.get("/api/comments", (req, res) => {
  const day = isValidDay(req.query.day) ? req.query.day : dayString();
  res.json({ day, comments: getCommentsForDay(day) });
});

app.post("/api/comments", (req, res) => {
  const { day, parentId, author, body } = req.body || {};

  if (!isValidDay(day)) {
    return res.status(400).json({ error: "Invalid or missing day." });
  }
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) {
    return res.status(400).json({ error: "Comment can't be empty." });
  }
  if (text.length > 4000) {
    return res.status(400).json({ error: "Comment is too long (4000 char max)." });
  }
  if (parentId != null) {
    if (!Number.isInteger(parentId) || !commentExists(parentId)) {
      return res.status(400).json({ error: "Reply target doesn't exist." });
    }
  }

  const name = (typeof author === "string" && author.trim().slice(0, 32)) || "anon";
  const comment = addComment({ day, parentId: parentId ?? null, author: name, body: text });
  res.status(201).json(comment);
});

app.post("/api/comments/:id/vote", (req, res) => {
  const id = Number(req.params.id);
  const dir = req.body?.dir;
  if (!Number.isInteger(id) || !commentExists(id)) {
    return res.status(404).json({ error: "Comment not found." });
  }
  if (dir !== 1 && dir !== -1 && dir !== 2 && dir !== -2) {
    // 1/-1 = apply a vote; 2/-2 = undo a previous vote (client tracks its own state)
    return res.status(400).json({ error: "Invalid vote direction." });
  }
  const updated = voteComment(id, dir);
  res.json({ id: updated.id, score: updated.score });
});

// SPA fallback so refreshing on any client route still serves the app.
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`sabcdef running at http://localhost:${PORT}`);
});
