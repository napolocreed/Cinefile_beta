// Splitting the interface into modules bought readability at the price of a manifest: every runtime file has to
// be named twice, once in the service worker's cache list and once in the Pages build. Nothing in the language
// enforces that, and a file missing from either list fails in the least useful way — offline, or in production
// only. So the module graph is walked from the real entry point and both lists are checked against it.

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

test("every module the browser loads is cached by the service worker", async () => {
  const graph = await runtimeModuleGraph("src/main.js");
  const worker = await readFile(resolve(root, "public/sw.js"), "utf8");
  const cached = new Set([...worker.matchAll(/"(src\/[^"]+\.js)"/g)].map((match) => match[1]));
  const missing = [...graph].filter((file) => !cached.has(file)).sort();
  assert.deepEqual(missing, [], `absents du cache hors ligne de public/sw.js : ${missing.join(", ")}`);
});

test("every module the browser loads is copied into the Pages build", async () => {
  const graph = await runtimeModuleGraph("src/main.js");
  const build = await readFile(resolve(root, "scripts/build-pages.mjs"), "utf8");
  const copied = new Set([...build.matchAll(/"(src\/[^"]+\.js)"/g)].map((match) => match[1]));
  const missing = [...graph].filter((file) => !copied.has(file)).sort();
  assert.deepEqual(missing, [], `absents de scripts/build-pages.mjs : ${missing.join(", ")}`);
});

test("the stylesheet only asks for fonts that ship with the build", async () => {
  const styles = await readFile(resolve(root, "src/styles.css"), "utf8");
  const requested = [...styles.matchAll(/url\("\.\.\/(assets\/[^"]+\.woff2)"\)/g)].map((match) => match[1]);
  assert.equal(requested.length > 0, true);
  const build = await readFile(resolve(root, "scripts/build-pages.mjs"), "utf8");
  const worker = await readFile(resolve(root, "public/sw.js"), "utf8");
  for (const font of new Set(requested)) {
    assert.equal(build.includes(`public/${font}`), true, `${font} n’est pas copié par le build Pages`);
    assert.equal(worker.includes(`"${font}"`), true, `${font} n’est pas mis en cache hors ligne`);
  }
});

// The server edition serves src/ straight from disk, so a module that exists only in the manifest would 404 on
// the very first load rather than at some later route.
test("no manifest entry names a file that does not exist", async () => {
  const build = await readFile(resolve(root, "scripts/build-pages.mjs"), "utf8");
  const listed = [...build.matchAll(/"((?:public|src)\/[^"]+\.(?:js|css|woff2|svg|png|ico|webmanifest))"/g)].map((match) => match[1]);
  for (const file of new Set(listed)) {
    await assert.doesNotReject(readFile(resolve(root, file)), `${file} est listé mais absent du dépôt`);
  }
});
