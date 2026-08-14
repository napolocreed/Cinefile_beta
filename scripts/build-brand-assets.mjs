// Le logo livré est une planche de 1254² pesant 1,9 Mo, opaque sur son bordeaux, gravure ET typographie dans la
// même image. L'accueil n'a besoin que de la gravure, et une affiche mobile n'a pas les moyens de deux mégaoctets :
// ce script découpe l'emblème et le ré-encode en WebP.
//
// Il n’y a ni ImageMagick ni sharp dans ce dépôt, et en ajouter un pour une découpe serait cher payé. Le
// Chromium que Playwright installe déjà pour les tests sait décoder un PNG et encoder un WebP ; on le pilote en
// CDP et il fait l'affaire. D'où le détour par un navigateur pour un travail d'image.
//
//   node scripts/build-brand-assets.mjs
//
// Les fichiers produits sont versionnés : personne n'a besoin d'un navigateur pour lancer l'app, seulement pour
// refabriquer la découpe le jour où la planche source change.

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SOURCE = "__l5e/assets-v1/8a9f592b-23da-4698-8a14-e0016a7b6c74/cinefil-logo.png";
const OUTPUT_DIRECTORY = resolve(root, "public/assets/brand");
const PORT = 4319;

// Mesuré sur la planche : l'emblème occupe le haut, la typographie commence à y = 740. On coupe avant, pour que
// l'accueil ne se retrouve pas avec deux fois le nom du jeu — une fois gravé, une fois composé en Oswald.
const EMBLEM = { x: 246, y: 96, w: 758, h: 626 };

const RECIPES = [
  { file: "emblem.webp", size: 760, quality: 0.9 },
];

function findChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Aucun Chromium trouvé. Renseignez PLAYWRIGHT_EXECUTABLE_PATH.");
  return found;
}

// Le canvas refuse de lire les pixels d'une image chargée en file:// : il faut une vraie origine. Ce serveur
// d'une ligne n'existe que le temps de la découpe.
function serveSource() {
  return new Promise((ready) => {
    const publicRoot = join(root, "public");
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, "http://x").pathname).replace(/^\/+/, "");
      const file = join(publicRoot, path);
      if (!file.startsWith(publicRoot) || !existsSync(file)) {
        response.statusCode = 404;
        return response.end();
      }
      response.setHeader("Content-Type", "image/png");
      createReadStream(file).pipe(response);
    });
    server.listen(PORT, "127.0.0.1", () => ready(server));
  });
}

async function connect(executablePath, url) {
  const profile = mkdtempSync(join(tmpdir(), "cinefil-brand-"));
  const browser = spawn(executablePath, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--remote-debugging-port=9333", `--user-data-dir=${profile}`, url,
  ], { stdio: "ignore" });

  let target = null;
  for (let attempt = 0; attempt < 80 && !target; attempt += 1) {
    await new Promise((wait) => setTimeout(wait, 250));
    try {
      const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
      target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    } catch { /* le navigateur n'écoute pas encore */ }
  }
  if (!target) {
    browser.kill("SIGKILL");
    throw new Error("Chromium n'a jamais exposé de page.");
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, fail) => { socket.onopen = open; socket.onerror = fail; });
  const pending = new Map();
  let nextId = 1;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const slot = pending.get(message.id);
    if (!slot) return;
    pending.delete(message.id);
    message.error ? slot.reject(new Error(JSON.stringify(message.error))) : slot.resolve(message.result);
  };

  const evaluate = (expression) => new Promise((done, fail) => {
    const id = nextId += 1;
    pending.set(id, { resolve: done, reject: fail });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  }).then((result) => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "évaluation refusée");
    return result.result.value;
  });

  // Tant que la page en est à « about:blank », le contexte d'exécution peut être remplacé sous nos pieds et le
  // décodage part sur une origine qui n'existe pas. On attend que le document soit posé.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate("document.readyState").catch(() => null) === "complete") break;
    await new Promise((wait) => setTimeout(wait, 250));
  }

  return { evaluate, close: () => { socket.close(); browser.kill("SIGKILL"); } };
}

export async function buildBrandAssets() {
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const server = await serveSource();
  const page = await connect(findChromium(), `http://127.0.0.1:${PORT}/${SOURCE}`);
  try {
    for (const recipe of RECIPES) {
      const encoded = await page.evaluate(`(async () => {
        const crop = ${JSON.stringify(EMBLEM)};
        const image = new Image();
        // URL absolue : au moment où le script s'exécute la page peut encore être « about:blank », où un
        // chemin relatif ne résout sur rien.
        image.src = ${JSON.stringify(`http://127.0.0.1:${PORT}/${SOURCE}`)};
        await image.decode();
        const width = ${recipe.size};
        const height = Math.round(width * crop.h / crop.w);
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d");
        context.imageSmoothingQuality = "high";
        context.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
        const blob = await canvas.convertToBlob({ type: "image/webp", quality: ${recipe.quality} });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { base64: btoa(binary), width, height };
      })()`);
      const buffer = Buffer.from(encoded.base64, "base64");
      writeFileSync(join(OUTPUT_DIRECTORY, recipe.file), buffer);
      console.log(`${recipe.file} · ${encoded.width}×${encoded.height} · ${(buffer.length / 1024).toFixed(1)} ko`);
    }
  } finally {
    page.close();
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await buildBrandAssets();
