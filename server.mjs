import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "public");
const port = Number(process.env.PORT || 4173);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const relative = normalize(pathname).replace(/^([/\\])+/, "");
  let target = join(root, relative);
  if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) {
    target = join(root, "index.html");
  }
  response.setHeader("Content-Type", mime[extname(target)] || "application/octet-stream");
  response.setHeader("Cache-Control", extname(target) === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
  createReadStream(target).pipe(response);
}).listen(port, "0.0.0.0", () => {
  console.log(`CinéFil disponible sur http://localhost:${port}`);
});
