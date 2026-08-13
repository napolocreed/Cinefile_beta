import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { createTmdbClient } from "./src/server/tmdb.js";
import { createPublishedCatalog } from "./src/server/published-catalog.js";
import { createLinkVerifier } from "./src/server/verify.js";

const workspaceRoot = process.cwd();
const publicRoot = join(workspaceRoot, "public");
const port = Number(process.env.PORT || 4173);
const tmdb = createTmdbClient();
const publishedCatalog = createPublishedCatalog();
const linkVerifier = createLinkVerifier({ tmdb });
// A borrowed API is opened by name, never by reflex. This server fronts a TMDb token with a quota and a
// verification cascade that hits Wikidata and Wikipédia under its own User-Agent: "*" would publish both as a
// free proxy for any page on the web. The owner declares the editions allowed to borrow it, and only those get an
// Access-Control-Allow-Origin. ALLOWED_ORIGINS=* stays possible, but has to be asked for.
const allowedOriginList = String(process.env.ALLOWED_ORIGINS ?? "").split(/[\s,]+/).filter(Boolean);
const allowAnyOrigin = allowedOriginList.includes("*");
const allowedOrigins = new Set(allowedOriginList.flatMap((value) => {
  try {
    return [new URL(value).origin];
  } catch {
    return [];
  }
}));
const corsEnabled = allowAnyOrigin || allowedOrigins.size > 0;
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

// Applied to /api/* only: the static files are served to whoever asks for them anyway, and a page that could read
// them cross-origin gains nothing it cannot already fetch.
function applyCors(request, response) {
  const origin = request.headers.origin;
  if (!corsEnabled || !origin) return false;
  // Responses here carry public Cache-Control; without this a proxy could replay one origin's answer to another.
  response.setHeader("Vary", "Origin");
  if (!allowAnyOrigin && !allowedOrigins.has(origin)) return false;
  response.setHeader("Access-Control-Allow-Origin", origin);
  return true;
}

async function handleApi(request, response, url) {
  const allowed = applyCors(request, response);
  // The preflight has to be answered before the method check below, which knows nothing but GET.
  if (request.method === "OPTIONS") {
    response.statusCode = allowed ? 204 : 403;
    if (allowed) {
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] ?? "Accept");
      response.setHeader("Access-Control-Max-Age", "600");
    }
    response.end();
    return true;
  }
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    sendJson(response, 405, { error: "Méthode non autorisée." });
    return true;
  }
  if (url.pathname === "/api/catalog/status") {
    sendJson(response, 200, { configured: tmdb.configured, source: tmdb.configured ? "tmdb" : "local", snapshot: "cinema-knowledge-v2", verification: linkVerifier.status() }, "public, max-age=60");
    return true;
  }
  if (url.pathname === "/api/verify-link") {
    const left = String(url.searchParams.get("left") ?? "");
    const right = String(url.searchParams.get("right") ?? "");
    try {
      const result = await linkVerifier.verify({
        left,
        right,
        leftTmdbId: url.searchParams.get("leftTmdbId"),
        rightTmdbId: url.searchParams.get("rightTmdbId"),
        locale: String(url.searchParams.get("locale") ?? "fr-FR").slice(0, 12),
      });
      const maxAge = result.verdict === "CONFIRMED" ? 86_400 : result.verdict === "NOT_FOUND" ? 3_600 : 300;
      sendJson(response, 200, result, `public, max-age=${maxAge}`);
    } catch (error) {
      sendJson(response, error.status === 400 ? 400 : 500, { error: error.status === 400 ? error.message : "La vérification est momentanément indisponible." });
    }
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
  const localPersonMatch = url.pathname.match(/^\/api\/catalog\/people\/local\/(person_[a-z0-9]+)$/);
  if (localPersonMatch) {
    try {
      const person = await publishedCatalog.getPerson(localPersonMatch[1]);
      if (!person) {
        sendJson(response, 404, { error: "Artiste local introuvable." });
        return true;
      }
      sendJson(response, 200, { configured: tmdb.configured, source: "published-tmdb", person }, "public, max-age=86400, stale-while-revalidate=604800");
    } catch {
      sendJson(response, 503, { error: "Le catalogue publié est momentanément indisponible." });
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
  const extension = extname(target);
  const unversionedRuntime = relative === "sw.js" || relative === "manifest.webmanifest" || (relative.startsWith("src/") && !relative.startsWith("src/data/"));
  const cacheControl = extension === ".html" || unversionedRuntime
    ? "no-cache"
    : relative.startsWith("src/data/") ? "public, max-age=3600" : "public, max-age=31536000, immutable";
  response.setHeader("Content-Type", mime[extension] || "application/octet-stream");
  response.setHeader("Cache-Control", cacheControl);
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
  const borrowers = allowAnyOrigin ? "toutes origines" : allowedOrigins.size ? [...allowedOrigins].join(", ") : "même origine seulement";
  console.log(`CinéFil disponible sur http://localhost:${port} · catalogue ${tmdb.configured ? "TMDb + local" : "local"} · API ${borrowers}`);
});
