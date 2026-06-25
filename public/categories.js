// Loads the daily category configs from the categories/ folder. Each day is a
// JSON file (categories/dd-monthname-year_categoryname.json) with the shape
// { date, name, theme, special_day, items }, where each item is
// { id, name, emoji }. categories/index.json lists the files to load.
//
// Each item keeps a stable `id` (the key used when saving tier placements) and
// an `emoji` visual — swap `emoji` for an `img` URL later without touching the
// tier logic.

const CATEGORIES_DIR = "categories";

// Fetch the manifest, then every config it lists. Returns the parsed configs in
// manifest order. Throws if the manifest can't be loaded so the caller can show
// an error rather than silently running with no categories.
export async function loadCategories() {
  const manifest = await fetch(`${CATEGORIES_DIR}/index.json`).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load categories/index.json (${r.status})`);
    return r.json();
  });
  const files = Array.isArray(manifest) ? manifest : manifest.files || [];
  return Promise.all(
    files.map((file) =>
      fetch(`${CATEGORIES_DIR}/${file}`).then((r) => {
        if (!r.ok) throw new Error(`Couldn't load categories/${file} (${r.status})`);
        return r.json();
      })
    )
  );
}
