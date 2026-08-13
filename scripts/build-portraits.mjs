import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const IMAGE_ROOT = "https://image.tmdb.org/t/p/w185";

// The static edition already ships portraits inside the TMDb overlay index. This much smaller file gives the
// server edition the same faces without downloading a filmography nobody asked for yet.
export async function buildPortraitIndex({
  inputPath = resolve(root, "src/data/tmdb-overlay.json"),
  outputPath = resolve(root, "src/data/tmdb-portraits.json"),
} = {}) {
  const overlay = JSON.parse(await readFile(inputPath, "utf8"));
  if (overlay.version !== 2 || !Array.isArray(overlay.people)) throw new Error("L’overlay TMDb source doit respecter le schéma compact v2.");
  const people = {};
  let skipped = 0;
  for (const person of [...overlay.people].sort((left, right) => String(left.localPersonId).localeCompare(String(right.localPersonId)))) {
    const path = String(person.profilePath ?? "");
    if (!person.localPersonId || !path.startsWith(`${IMAGE_ROOT}/`)) {
      if (path) skipped += 1;
      continue;
    }
    people[person.localPersonId] = path.slice(IMAGE_ROOT.length);
  }
  const index = { version: 1, baseSnapshotId: overlay.baseSnapshotId, generatedAt: overlay.generatedAt, base: IMAGE_ROOT, people };
  const payload = `${JSON.stringify(index)}\n`;
  await writeFile(outputPath, payload);
  return { portraits: Object.keys(people).length, skipped, bytes: Buffer.byteLength(payload) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPortraitIndex();
  console.log(`${result.portraits} portraits indexés (${result.bytes} octets, ${result.skipped} ignorés).`);
}
