import { normalizeText } from "./identity.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const unique = (values) => [...new Set(values.filter(Boolean))];

function isFresh(entry, freshnessDays, now) {
  const syncedAt = Date.parse(entry?.syncedAt ?? "");
  return Number.isFinite(syncedAt) && syncedAt >= now - freshnessDays * DAY_MS;
}

function addToMultiMap(map, key, value) {
  if (!key) return;
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

export function createStaticOverlay({
  database,
  index = {},
  fetchImpl = globalThis.fetch,
  resolveAsset = (path) => path,
  freshnessDays = 180,
  now = Date.now(),
} = {}) {
  if (!database) throw new TypeError("A cinema database is required.");

  const entries = (Array.isArray(index.people) ? index.people : [])
    .filter((entry) => entry?.localPersonId && entry?.shard && isFresh(entry, freshnessDays, now));
  const byLocalId = new Map();
  const byTmdbId = new Map();
  const byName = new Map();
  const loaded = new Set();
  const pending = new Map();

  for (const entry of entries) {
    byLocalId.set(entry.localPersonId, entry);
    if (entry.externalIds?.tmdb !== undefined) byTmdbId.set(String(entry.externalIds.tmdb), entry);
    addToMultiMap(byName, normalizeText(entry.name), entry);
    const localPerson = database.findActor(entry.localPersonId);
    database.upsertPerson({
      ...entry,
      id: entry.localPersonId,
      name: localPerson?.name ?? entry.name,
      aliases: unique([...(entry.aliases ?? []), entry.name !== localPerson?.name ? entry.name : null]),
      credits: [],
    }, { source: "tmdb" });
  }

  function findEntry(candidate) {
    if (!candidate) return null;
    const localId = candidate.localPersonId ?? candidate.id;
    if (byLocalId.has(localId)) return byLocalId.get(localId);
    const tmdbId = candidate.externalIds?.tmdb;
    if (tmdbId !== undefined && byTmdbId.has(String(tmdbId))) return byTmdbId.get(String(tmdbId));
    const sameName = byName.get(normalizeText(candidate.name)) ?? [];
    if (sameName.length === 1) return sameName[0];
    return sameName.find((entry) => !candidate.birthYear || !entry.birthYear || Number(entry.birthYear) === Number(candidate.birthYear)) ?? null;
  }

  async function hydrate(candidate, { signal } = {}) {
    const entry = findEntry(candidate);
    const existing = database.findActor(candidate?.id) ?? database.findActor(candidate?.name);
    if (!entry) return existing;
    if (loaded.has(entry.localPersonId)) return database.findActor(entry.localPersonId) ?? existing;
    if (pending.has(entry.localPersonId)) return pending.get(entry.localPersonId);

    const operation = (async () => {
      if (!fetchImpl) throw new Error("static-overlay-unavailable");
      const path = `src/data/tmdb-shards/${entry.shard}`;
      const response = await fetchImpl(resolveAsset(path), { headers: { Accept: "application/json" }, signal });
      if (!response.ok) throw new Error(`static-overlay-${response.status}`);
      const payload = await response.json();
      if (payload?.version !== 1 || payload.person?.localPersonId !== entry.localPersonId || !Array.isArray(payload.works)) {
        throw new Error("static-overlay-invalid");
      }

      const workIdMap = new Map();
      for (const work of payload.works) {
        const merged = database.upsertWork(work, { source: "tmdb" });
        if (merged) workIdMap.set(work.id, merged.id);
      }
      const person = database.upsertPerson({
        ...payload.person,
        id: entry.localPersonId,
        name: existing?.name ?? entry.name,
        aliases: unique([...(payload.person.aliases ?? []), payload.person.name !== existing?.name ? payload.person.name : null]),
        credits: (payload.person.credits ?? []).map((workId) => workIdMap.get(workId)).filter(Boolean),
      }, { source: "tmdb" });
      loaded.add(entry.localPersonId);
      return person ?? existing;
    })();

    pending.set(entry.localPersonId, operation);
    try {
      return await operation;
    } finally {
      pending.delete(entry.localPersonId);
    }
  }

  return {
    hydrate,
    findEntry,
    stats: () => ({ indexed: entries.length, loaded: loaded.size }),
  };
}
