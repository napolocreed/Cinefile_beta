import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");

export async function buildTmdbShards({
  inputPath = resolve(root, "src/data/tmdb-overlay.json"),
  outputDirectory = resolve(root, "dist/src/data"),
} = {}) {
  const overlay = JSON.parse(await readFile(inputPath, "utf8"));
  if (overlay.version !== 2 || !Array.isArray(overlay.people) || !Array.isArray(overlay.works)) {
    throw new Error("L’overlay TMDb source doit respecter le schéma compact v2.");
  }

  const worksById = new Map(overlay.works.map((work) => [work.id, work]));
  const shardsDirectory = join(outputDirectory, "tmdb-shards");
  await rm(shardsDirectory, { recursive: true, force: true });
  await mkdir(shardsDirectory, { recursive: true });

  const people = [];
  let shardBytes = 0;
  for (const person of [...overlay.people].sort((left, right) => left.localPersonId.localeCompare(right.localPersonId))) {
    if (!/^[a-zA-Z0-9_-]+$/.test(person.localPersonId ?? "")) throw new Error(`Identifiant local invalide: ${person.localPersonId}`);
    const works = (person.credits ?? []).map((workId) => worksById.get(workId));
    if (works.some((work) => !work)) throw new Error(`Crédit orphelin dans le shard ${person.localPersonId}.`);
    const shard = `${person.localPersonId}.json`;
    const payload = `${JSON.stringify({ version: 1, generatedAt: overlay.generatedAt, person, works })}\n`;
    await writeFile(join(shardsDirectory, shard), payload);
    shardBytes += Buffer.byteLength(payload);
    const { credits, ...metadata } = person;
    people.push({ ...metadata, shard });
  }

  const index = {
    version: 1,
    baseSnapshotId: overlay.baseSnapshotId,
    generatedAt: overlay.generatedAt,
    refreshAfterDays: overlay.refreshAfterDays,
    stats: { ...overlay.stats, shardBytes },
    failures: overlay.failures ?? [],
    people,
  };
  await mkdir(dirname(join(outputDirectory, "tmdb-overlay-index.json")), { recursive: true });
  await writeFile(join(outputDirectory, "tmdb-overlay-index.json"), `${JSON.stringify(index)}\n`);
  return { people: people.length, shards: people.length, shardBytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildTmdbShards();
  console.log(`${result.shards} shards TMDb générés (${result.shardBytes} octets).`);
}
