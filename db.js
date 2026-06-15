import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "sabcdef.db"));

// WAL gives us better concurrency for simultaneous readers/writers.
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    day         TEXT    NOT NULL,            -- YYYY-MM-DD the comment belongs to
    parent_id   INTEGER,                     -- NULL for top-level, else another comment id
    author      TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    score       INTEGER NOT NULL DEFAULT 1,  -- starts at 1 (the author's implicit upvote)
    created_at  TEXT    NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_comments_day    ON comments(day);
  CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
`);

const statements = {
  insertComment: db.prepare(`
    INSERT INTO comments (day, parent_id, author, body, score, created_at)
    VALUES (@day, @parent_id, @author, @body, 1, @created_at)
  `),
  getCommentsForDay: db.prepare(`
    SELECT id, parent_id, author, body, score, created_at
    FROM comments
    WHERE day = ?
    ORDER BY created_at ASC
  `),
  getComment: db.prepare(`SELECT * FROM comments WHERE id = ?`),
  voteComment: db.prepare(`UPDATE comments SET score = score + ? WHERE id = ?`),
  countForDay: db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE day = ?`)
};

export function addComment({ day, parentId, author, body }) {
  const info = statements.insertComment.run({
    day,
    parent_id: parentId ?? null,
    author,
    body,
    created_at: new Date().toISOString()
  });
  return statements.getComment.get(info.lastInsertRowid);
}

export function getCommentsForDay(day) {
  return statements.getCommentsForDay.all(day);
}

export function commentExists(id) {
  return !!statements.getComment.get(id);
}

export function voteComment(id, delta) {
  statements.voteComment.run(delta, id);
  return statements.getComment.get(id);
}

export function countForDay(day) {
  return statements.countForDay.get(day).n;
}

export default db;
