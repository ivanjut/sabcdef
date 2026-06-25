// Generates the per-day category config files in public/categories/ from the
// planning table in scripts/calendar.txt, then rebuilds categories/index.json.
//
// The table is the column layout copied from the Google Doc (Date, Day,
// Category, Theme, Special day, Tier, Items). Blank lines and the header are
// ignored; each record is anchored on its Date line. The "Tier" column is the
// author's own category rating and is NOT written to the configs (it doesn't
// map to the app's S–F item tiers) — say so if you want it included.
//
// Re-run any time the table changes:  node scripts/generate-categories.mjs
//
// Usage notes:
//   - Dates have no year in the table; START_YEAR is assumed and the year is
//     bumped whenever the month wraps (so Dec → Jan rolls over correctly).
//   - Item ids are slugged from the item name and de-duplicated per category;
//     emoji-only items (e.g. the Emojis category) get item-N ids.
//   - Files listed in KEEP_FILES are never deleted or overwritten (used to
//     preserve hand-made days like Weekend Activities that aren't in the table).

import { readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "scripts", "calendar.txt");
const OUT_DIR = join(ROOT, "public", "categories");
const START_YEAR = 2026;
const KEEP_FILES = ["24-june-2026_weekend-activities.json"];

const MONTHS = {
  jan: ["01", "january"], feb: ["02", "february"], mar: ["03", "march"],
  apr: ["04", "april"], may: ["05", "may"], jun: ["06", "june"],
  jul: ["07", "july"], aug: ["08", "august"], sep: ["09", "september"],
  oct: ["10", "october"], nov: ["11", "november"], dec: ["12", "december"]
};

const DATE_RE = /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i;
const TIER_RE = /^[SABCDEF]$/;

function slugify(s) {
  return s
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// "🇮🇹 Italian" -> { emoji: "🇮🇹", name: "Italian" }. Emoji-only items
// (no space, e.g. the Emojis category) keep the glyph as their name.
function splitItem(raw) {
  const s = raw.trim();
  const i = s.indexOf(" ");
  if (i === -1) return { emoji: s, name: s };
  return { emoji: s.slice(0, i).trim(), name: s.slice(i + 1).trim() };
}

function parseItems(line, warn) {
  const used = new Set();
  return line.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean).map((raw, idx) => {
    const { emoji, name } = splitItem(raw);
    let id = slugify(name) || `item-${idx + 1}`;
    if (used.has(id)) {
      const base = id;
      let n = 2;
      while (used.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
      warn(`duplicate id "${base}" -> "${id}" (item "${name}")`);
    }
    used.add(id);
    return { id, name, emoji };
  });
}

// Split the source into records: drop blank lines, then start a new record at
// every line that looks like a date. Anything before the first date (the header)
// is ignored.
function toRecords(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    if (DATE_RE.test(line)) records.push([line]);
    else if (records.length) records[records.length - 1].push(line);
  }
  return records;
}

function serialize(cfg) {
  const items = cfg.items
    .map((it) => `    { "id": ${JSON.stringify(it.id)}, "name": ${JSON.stringify(it.name)}, "emoji": ${JSON.stringify(it.emoji)} }`)
    .join(",\n");
  return [
    "{",
    `  "date": ${JSON.stringify(cfg.date)},`,
    `  "name": ${JSON.stringify(cfg.name)},`,
    `  "theme": ${JSON.stringify(cfg.theme)},`,
    `  "special_day": ${JSON.stringify(cfg.special_day)},`,
    `  "items": [`,
    items,
    "  ]",
    "}",
    ""
  ].join("\n");
}

async function main() {
  const records = toRecords(await readFile(SRC, "utf8"));
  const warnings = [];
  const configs = [];
  let year = START_YEAR;
  let prevMonth = -1;

  for (const rec of records) {
    const [dateLine, , category, theme, ...rest] = rec;
    const items = rest.pop();
    const tier = rest.pop();
    const special_day = rest.join(" ");
    if (!TIER_RE.test(tier)) {
      throw new Error(`Expected a tier (single letter) for "${category}" on "${dateLine}", got "${tier}". ` +
        `Check the table row has Date, Day, Category, Theme, [Special day], Tier, Items.`);
    }

    const [, dd, monShort] = dateLine.match(DATE_RE);
    const [mm, monthFull] = MONTHS[monShort.toLowerCase()];
    const monthNum = Number(mm);
    if (prevMonth !== -1 && monthNum < prevMonth) year++; // month wrapped → next year
    prevMonth = monthNum;
    const day2 = dd.padStart(2, "0");

    const fileName = `${day2}-${monthFull}-${year}_${slugify(category)}.json`;
    configs.push({
      fileName,
      date: `${year}-${mm}-${day2}`,
      name: category,
      theme,
      special_day,
      items: parseItems(items, (m) => warnings.push(`${fileName}: ${m}`))
    });
  }

  // Sanity: no duplicate or skipped calendar days.
  const sorted = [...configs].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1].date}T00:00:00Z`);
    const cur = new Date(`${sorted[i].date}T00:00:00Z`);
    const gapDays = Math.round((cur - prev) / 86_400_000);
    if (gapDays === 0) warnings.push(`duplicate date ${sorted[i].date}`);
    else if (gapDays > 1) warnings.push(`gap before ${sorted[i].date} (${gapDays - 1} day(s) missing)`);
  }

  // Write the configs.
  const generated = new Set(configs.map((c) => c.fileName));
  for (const cfg of configs) {
    if (KEEP_FILES.includes(cfg.fileName)) continue; // never clobber a kept day
    await writeFile(join(OUT_DIR, cfg.fileName), serialize(cfg));
  }

  // Remove stale generated files so re-runs stay idempotent (keep index.json
  // and any KEEP_FILES).
  for (const f of await readdir(OUT_DIR)) {
    if (f === "index.json" || KEEP_FILES.includes(f) || generated.has(f)) continue;
    if (f.endsWith(".json")) {
      await unlink(join(OUT_DIR, f));
      warnings.push(`removed stale file ${f}`);
    }
  }

  // Rebuild the manifest from everything on disk, ordered by date.
  const onDisk = (await readdir(OUT_DIR)).filter((f) => f.endsWith(".json") && f !== "index.json");
  const withDates = await Promise.all(
    onDisk.map(async (f) => ({ f, date: JSON.parse(await readFile(join(OUT_DIR, f), "utf8")).date }))
  );
  withDates.sort((a, b) => a.date.localeCompare(b.date));
  const manifest = { files: withDates.map((x) => x.f) };
  await writeFile(join(OUT_DIR, "index.json"), JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Generated ${configs.length} config(s); manifest lists ${manifest.files.length} file(s).`);
  console.log(`Date range: ${sorted[0].date} → ${sorted[sorted.length - 1].date}`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
