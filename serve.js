// Minimal zero-dependency static server for local development. It serves the
// same files GitHub Pages will serve (the public/ folder). Production deploy is
// handled by .github/workflows/deploy.yml — this is only for `npm start`.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./public", import.meta.url));
const PORT = process.env.PORT || 3000;

const TYPES = {
  ".html": "text/html; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".js": "text/javascript; charset=UTF-8",
  ".json": "application/json; charset=UTF-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    const filePath = normalize(join(ROOT, pathname));
    // Block path traversal outside ROOT.
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`sabcdef (static) at http://localhost:${PORT}`);
});
