import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { buildTmdbShards } from "./build-tmdb-shards.mjs";

const root = resolve(import.meta.dirname, "..");
const argumentMap = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...value] = argument.replace(/^--/, "").split("=");
  return [key, value.join("=") || true];
}));

function normalizeBasePath(value) {
  let base = String(value ?? "/").trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  if (base.includes("..") || /[?#\\]/.test(base)) throw new Error(`Sous-chemin Pages invalide: ${base}`);
  return base.replace(/\/{2,}/g, "/");
}

// The Pages edition has no server. Pointed at a deployed Node instance it borrows one, which is the only way a
// static build can reach an artist the snapshot never had. No value means today's build, unchanged and offline.
// A malformed one stops the build rather than shipping a page that calls nowhere.
function normalizeApiBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`API_BASE_URL invalide: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`API_BASE_URL doit être en http(s): ${raw}`);
  if (url.search || url.hash) throw new Error(`API_BASE_URL ne doit porter ni requête ni fragment: ${raw}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const repositoryName = String(process.env.GITHUB_REPOSITORY ?? "").split("/")[1];
const inferredBase = repositoryName ? `/${repositoryName}/` : "/";
const basePath = normalizeBasePath(argumentMap.get("base") ?? process.env.PAGES_BASE_PATH ?? process.env.BASE_PATH ?? inferredBase);
const apiBase = normalizeApiBaseUrl(argumentMap.get("api-base") ?? process.env.API_BASE_URL);
const output = resolve(String(argumentMap.get("output") ?? process.env.OUTPUT_DIR ?? resolve(root, "dist")));
const unsafeOutputs = new Set([root, parse(output).root, resolve(root, "public"), resolve(root, "src")]);
if (unsafeOutputs.has(output)) throw new Error(`Dossier de sortie refusé: ${output}`);

const files = [
  "public/favicon.ico",
  "public/manifest.webmanifest",
  "public/sw.js",
  "public/assets/inter-latin-400-normal-C38fXH4l.woff2",
  "public/assets/inter-latin-600-normal-LgqL8muc.woff2",
  "public/assets/playfair-display-latin-700-normal-CuDiGg7c.woff2",
  "public/assets/tmdb-logo.svg",
  "public/__l5e/assets-v1/5ff43c75-eae3-43ba-80e0-f5b47be859df/cinema-seats.png",
  "public/__l5e/assets-v1/8a9f592b-23da-4698-8a14-e0016a7b6c74/cinefil-logo.png",
  "src/main.js",
  "src/styles.css",
  "src/game/achievements.js",
  "src/game/catalog.js",
  "src/game/database.js",
  "src/game/diagnostics.js",
  "src/game/engine.js",
  "src/game/identity.js",
  "src/game/storage.js",
  "src/game/static-overlay.js",
  "src/game/transfer.js",
  "src/voice/entity-resolver.js",
  "src/voice/phonetics.js",
  "src/voice/speech-session.js",
  "src/voice/turn-buffer.js",
  "src/data/cinema-database.json",
  "src/data/cinema-knowledge.json",
  "src/data/cinema-synonyms.json",
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const relativePath of files) {
  const destinationPath = resolve(output, relativePath.replace(/^public\//, ""));
  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(resolve(root, relativePath), destinationPath);
}

await buildTmdbShards({
  inputPath: resolve(root, "src/data/tmdb-overlay.json"),
  outputDirectory: resolve(output, "src/data"),
});

// A published build states which commit it came from, so "is my deployment live?" is answered by looking at
// the page instead of guessing at caches.
const buildStamp = [process.env.GITHUB_SHA?.slice(0, 7), new Date().toISOString().slice(0, 16).replace("T", " ")].filter(Boolean).join(" · ");
const sourceHtml = await readFile(resolve(root, "public/index.html"), "utf8");
const appHtml = sourceHtml
  .replace('<base href="/" />', `<base href="${basePath}" />`)
  .replace('<meta name="app-base" content="/" />', `<meta name="app-base" content="${basePath}" />`)
  .replace('<meta name="api-base" content="" />', `<meta name="api-base" content="${apiBase}" />`)
  .replace('<meta name="catalog-mode" content="remote" />', `<meta name="catalog-mode" content="static" />\n    <meta name="build-stamp" content="${buildStamp.replace(/[^\w .:·-]/g, "")}" />`);

await writeFile(resolve(output, "index.html"), appHtml);
await writeFile(resolve(output, "404.html"), appHtml);
await writeFile(resolve(output, ".nojekyll"), "");
for (const route of ["setup", "play", "results", "profiles"]) {
  const routeDirectory = resolve(output, route);
  await mkdir(routeDirectory, { recursive: true });
  await writeFile(resolve(routeDirectory, "index.html"), appHtml);
}

// An https page cannot call an http API: the browser blocks it as mixed content, and the edition would look
// broken rather than merely static.
if (apiBase.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(apiBase)) {
  console.warn(`Attention: API_BASE_URL est en http (${apiBase}); une page servie en https refusera cet appel.`);
}

console.log(`Build GitHub Pages prêt dans ${output} (base ${basePath}, API ${apiBase || "aucune — catalogue embarqué"}).`);
