// Splitting the interface into modules bought readability at the price of a manifest: every runtime file has to
// be named twice, once in the source and once in the service worker's cache list. Nothing in the language
// enforces that, and a file missing from the list fails in the least useful way — offline only, on a device that
// already installed the game. So the module graph is walked from the real entry point and checked against it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function runtimeModuleGraph(entry) {
  const reached = new Set();
  const walk = async (file) => {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    if (reached.has(relativePath)) return;
    reached.add(relativePath);
    const source = await readFile(file, "utf8");
    // Static imports only — the browser resolves nothing else at load time.
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+"(\.[^"]+)"/g)) {
      await walk(resolve(dirname(file), match[1]));
    }
  };
  await walk(resolve(root, entry));
  return reached;
}

const worker = await readFile(resolve(root, "public/sw.js"), "utf8");
const cached = new Set([...worker.matchAll(/"((?:src|assets)\/[^"]+)"/g)].map((match) => match[1]));

test("every module the browser loads is cached by the service worker", async () => {
  const graph = await runtimeModuleGraph("src/main.js");
  const missing = [...graph].filter((file) => !cached.has(file)).sort();
  assert.deepEqual(missing, [], `absents du cache hors ligne de public/sw.js : ${missing.join(", ")}`);
});

test("the stylesheet only asks for fonts that ship with the build", async () => {
  const styles = await readFile(resolve(root, "src/styles.css"), "utf8");
  const requested = [...styles.matchAll(/url\("\.\.\/(assets\/[^"]+\.woff2)"\)/g)].map((match) => match[1]);
  assert.equal(requested.length > 0, true);
  for (const font of new Set(requested)) {
    assert.equal(cached.has(font), true, `${font} n’est pas mis en cache hors ligne`);
  }
});

// The server serves src/ and public/ straight from disk, so a file named in the cache list but absent from the
// repository would 404 on the very first load rather than at some later route.
test("no cached entry names a file that does not exist", async () => {
  for (const file of cached) {
    const path = file.startsWith("assets/") ? `public/${file}` : file;
    await assert.doesNotReject(readFile(resolve(root, path)), `${file} est mis en cache mais absent du dépôt`);
  }
});
