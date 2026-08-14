// Un workflow qui appelle un script npm disparu échoue en zéro seconde, sur la seule machine qui compte, et le
// déploiement qui attend cette quality gate ne part jamais. Le lien entre les deux fichiers n'est vérifié par
// rien dans l'outillage : il l'est ici.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const scripts = new Set(Object.keys(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).scripts ?? {}));

test("every npm script a workflow runs exists in package.json", async () => {
  const directory = resolve(root, ".github/workflows");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  assert.equal(files.length > 0, true);
  const missing = [];
  for (const file of files) {
    const source = await readFile(resolve(directory, file), "utf8");
    // « npm run <script> », avec ou sans arguments passés derrière un --.
    for (const match of source.matchAll(/npm run ([\w:-]+)/g)) {
      if (!scripts.has(match[1])) missing.push(`${file} → npm run ${match[1]}`);
    }
  }
  assert.deepEqual(missing, [], `scripts appelés mais absents de package.json : ${missing.join(", ")}`);
});
