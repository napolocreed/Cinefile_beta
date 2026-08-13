import { normalizeText } from "./identity.js";

export const CATALOG_CACHE_KEY = "cinefil.catalog-cache.v1";
const MAX_CACHED_PEOPLE = 80;

function readJson(storage, key, fallback) {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // A remote result remains usable for the current session when storage is full.
  }
}

export function createCatalogCache(storage = globalThis.localStorage) {
  function load() {
    const value = readJson(storage, CATALOG_CACHE_KEY, { version: 1, people: [] });
    return value?.version === 1 && Array.isArray(value.people) ? value : { version: 1, people: [] };
  }

  function savePerson(person) {
    const cache = load();
    const key = person.externalIds?.tmdb ? `tmdb:${person.externalIds.tmdb}` : normalizeText(person.name);
    const people = [person, ...cache.people.filter((entry) => {
      const entryKey = entry.externalIds?.tmdb ? `tmdb:${entry.externalIds.tmdb}` : normalizeText(entry.name);
      return entryKey !== key;
    })].slice(0, MAX_CACHED_PEOPLE);
    writeJson(storage, CATALOG_CACHE_KEY, { version: 1, savedAt: new Date().toISOString(), people });
  }

  return { load, savePerson, clear: () => storage?.removeItem(CATALOG_CACHE_KEY) };
}

export function createHybridCatalog({ database, fetchImpl = globalThis.fetch, storage = globalThis.localStorage, remoteEnabled = true } = {}) {
  const cache = createCatalogCache(storage);
  const cached = cache.load();
  for (const person of cached.people) database.upsertPerson(person, { source: "tmdb" });
  let remoteState = remoteEnabled
    ? { checked: false, configured: null, online: globalThis.navigator?.onLine !== false, source: "local", static: false }
    : { checked: true, configured: false, online: globalThis.navigator?.onLine !== false, source: "snapshot", static: true };

  async function fetchJson(url, { signal } = {}) {
    if (!fetchImpl || globalThis.navigator?.onLine === false) throw new Error("offline");
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `catalog-${response.status}`);
    return payload;
  }

  async function status() {
    if (!remoteEnabled) return { ...remoteState };
    try {
      const payload = await fetchJson("/api/catalog/status");
      remoteState = { checked: true, configured: Boolean(payload.configured), online: true, source: payload.source ?? "local" };
    } catch {
      remoteState = { ...remoteState, checked: true, online: false };
    }
    return { ...remoteState };
  }

  async function search(query, options = {}) {
    const limit = Math.max(1, Math.min(12, Number(options.limit ?? 8)));
    const local = database.searchPeople(query, { ...options, limit });
    if (!remoteEnabled || normalizeText(query).length < 2 || options.remote === false || globalThis.navigator?.onLine === false) {
      return { results: local, remote: { ...remoteState, skipped: true } };
    }
    try {
      const parameters = new URLSearchParams({ query, limit: String(limit), locale: options.locale ?? "fr-FR" });
      const payload = await fetchJson(`/api/catalog/search?${parameters}`, { signal: options.signal });
      remoteState = { checked: true, configured: Boolean(payload.configured), online: true, source: payload.source ?? "tmdb" };
      const merged = [...local];
      for (const person of payload.results ?? []) {
        const tmdbKey = person.externalIds?.tmdb ? `tmdb:${person.externalIds.tmdb}` : null;
        const index = merged.findIndex((entry) => (tmdbKey && String(entry.externalIds?.tmdb) === String(person.externalIds?.tmdb)) || normalizeText(entry.name) === normalizeText(person.name));
        if (index >= 0) {
          merged[index] = {
            ...merged[index],
            profilePath: merged[index].profilePath || person.profilePath,
            knownFor: person.knownFor ?? merged[index].knownFor,
            externalIds: { ...merged[index].externalIds, ...person.externalIds },
            origin: "local+tmdb",
          };
        } else merged.push(person);
      }
      return { results: merged.slice(0, limit), remote: { ...remoteState } };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      remoteState = { ...remoteState, checked: true, online: false };
      return { results: local, remote: { ...remoteState, error: "unavailable" } };
    }
  }

  async function hydrate(candidate, { signal } = {}) {
    if (!candidate) return null;
    const existing = database.findActor(candidate.id) ?? database.findActor(candidate.name);
    if (existing && existing.creditCount && !String(candidate.origin ?? "").includes("tmdb")) return existing;
    const tmdbId = candidate.externalIds?.tmdb;
    if (!tmdbId) return existing ?? database.upsertPerson(candidate, { source: candidate.source ?? "manual" });
    if (!remoteEnabled) return existing ?? database.upsertPerson(candidate, { source: candidate.source ?? "tmdb" });
    if (existing && String(existing.externalIds?.tmdb ?? "") === String(tmdbId) && existing.source === "tmdb") return existing;
    const cachedPerson = cache.load().people.find((person) => String(person.externalIds?.tmdb) === String(tmdbId));
    if (cachedPerson) return database.upsertPerson(cachedPerson, { source: "tmdb" });
    const payload = await fetchJson(`/api/catalog/people/tmdb/${encodeURIComponent(tmdbId)}`, { signal });
    const person = database.upsertPerson(payload.person, { source: "tmdb" });
    cache.savePerson(payload.person);
    return person;
  }

  return {
    search,
    hydrate,
    status,
    getState: () => ({ ...remoteState }),
    clearCache: cache.clear,
  };
}
