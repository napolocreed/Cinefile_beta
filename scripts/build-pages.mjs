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

const repositoryName = String(process.env.GITHUB_REPOSITORY ?? "").split("/")[1];
const inferredBase = repositoryName ? `/${repositoryName}/` : "/";
const basePath = normalizeBasePath(argumentMap.get("base") ?? process.env.PAGES_BASE_PATH ?? process.env.BASE_PATH ?? inferredBase);
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

const sourceHtml = await readFile(resolve(root, "public/index.html"), "utf8");
const appHtml = sourceHtml
  .replace('<base href="/" />', `<base href="${basePath}" />`)
  .replace('<meta name="app-base" content="/" />', `<meta name="app-base" content="${basePath}" />`)
  .replace('<meta name="catalog-mode" content="remote" />', '<meta name="catalog-mode" content="static" />');

await writeFile(resolve(output, "index.html"), appHtml);
await writeFile(resolve(output, "404.html"), appHtml);
await writeFile(resolve(output, ".nojekyll"), "");
for (const route of ["setup", "play", "results", "profiles"]) {
  const routeDirectory = resolve(output, route);
  await mkdir(routeDirectory, { recursive: true });
  await writeFile(resolve(routeDirectory, "index.html"), appHtml);
}

console.log(`Build GitHub Pages prêt dans ${output} (base ${basePath}).`);
