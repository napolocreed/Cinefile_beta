import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { createTmdbClient } from "./src/server/tmdb.js";

const workspaceRoot = process.cwd();
const publicRoot = join(workspaceRoot, "public");
const port = Number(process.env.PORT || 4173);
const tmdb = createTmdbClient();
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(response, status, payload, cacheControl = "no-store") {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

async function handleApi(request, response, url) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Méthode non autorisée." });
    return true;
  }
  if (url.pathname === "/api/catalog/status") {
    sendJson(response, 200, { configured: tmdb.configured, source: tmdb.configured ? "tmdb" : "local", snapshot: "cinema-knowledge-v2" }, "public, max-age=60");
    return true;
  }
  if (url.pathname === "/api/catalog/search") {
    const query = String(url.searchParams.get("query") ?? "").trim().slice(0, 100);
    const locale = String(url.searchParams.get("locale") ?? "fr-FR").slice(0, 12);
    const limit = Math.max(1, Math.min(12, Number(url.searchParams.get("limit") ?? 8)));
    if (query.length < 2) {
      sendJson(response, 200, { configured: tmdb.configured, source: "tmdb", results: [] });
      return true;
    }
    if (!tmdb.configured) {
      sendJson(response, 200, { configured: false, source: "local", results: [] }, "public, max-age=60");
      return true;
    }
    try {
      const results = await tmdb.searchPeople(query, { locale, limit });
      sendJson(response, 200, { configured: true, source: "tmdb", results }, "public, max-age=900, stale-while-revalidate=86400");
    } catch (error) {
      sendJson(response, error.status && error.status < 500 ? error.status : 502, { error: "Le catalogue cinéma distant est momentanément indisponible." });
    }
    return true;
  }
  const personMatch = url.pathname.match(/^\/api\/catalog\/people\/tmdb\/(\d+)$/);
  if (personMatch) {
    if (!tmdb.configured) {
      sendJson(response, 503, { error: "TMDb n'est pas configuré sur ce serveur.", configured: false });
      return true;
    }
    try {
      const person = await tmdb.getPerson(personMatch[1], { locale: String(url.searchParams.get("locale") ?? "fr-FR").slice(0, 12) });
      sendJson(response, 200, { configured: true, source: "tmdb", person }, "public, max-age=86400, stale-while-revalidate=604800");
    } catch (error) {
      sendJson(response, error.status === 404 ? 404 : 502, { error: error.status === 404 ? "Artiste introuvable." : "La filmographie distante est momentanément indisponible." });
    }
    return true;
  }
  sendJson(response, 404, { error: "Route API inconnue." });
  return true;
}

function serveStatic(request, response, url) {
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const base = relative.startsWith("src/") ? workspaceRoot : publicRoot;
  let target = join(base, relative);
  const insideBase = target === base || target.startsWith(`${base}${sep}`);
  if (!insideBase || !existsSync(target) || statSync(target).isDirectory()) target = join(publicRoot, "index.html");
  response.setHeader("Content-Type", mime[extname(target)] || "application/octet-stream");
  response.setHeader("Cache-Control", extname(target) === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method === "HEAD") return response.end();
  createReadStream(target).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }
  serveStatic(request, response, url);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`CinéFil disponible sur http://localhost:${port} · catalogue ${tmdb.configured ? "TMDb + local" : "local"}`);
});
