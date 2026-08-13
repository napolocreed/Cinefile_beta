import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createServer } from "node:http";

const root = resolve(process.env.STATIC_ROOT ?? "dist");
const port = Number(process.env.PORT ?? 4174);
const basePath = `/${String(process.env.BASE_PATH ?? "Cinefile_beta").replace(/^\/+|\/+$/g, "")}/`;
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === basePath.slice(0, -1)) {
    response.statusCode = 308;
    response.setHeader("Location", basePath);
    response.end();
    return;
  }
  if (!url.pathname.startsWith(basePath)) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  let relative;
  try {
    relative = normalize(decodeURIComponent(url.pathname.slice(basePath.length))).replace(/^([/\\])+/, "");
  } catch {
    response.statusCode = 400;
    response.end("Bad request");
    return;
  }
  let target = join(root, relative || "index.html");
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
  if (!target.startsWith(`${root}${sep}`) || !existsSync(target)) target = join(root, "404.html");
  response.statusCode = target.endsWith("404.html") ? 404 : 200;
  response.setHeader("Content-Type", mime[extname(target)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", extname(target) === ".html" ? "no-cache" : "public, max-age=3600");
  if (request.method === "HEAD") response.end();
  else createReadStream(target).pipe(response);
}).listen(port, "127.0.0.1", () => {
  console.log(`Build Pages disponible sur http://127.0.0.1:${port}${basePath}`);
});
