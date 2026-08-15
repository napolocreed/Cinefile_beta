import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmdbClient } from "../src/server/tmdb.js";
import { nameKeys, normalizeText, stableId, strictIdentityKey } from "../src/game/identity.js";
import { CORE_SCOPE, isWorkInScope, workKind } from "../src/game/work-kinds.js";

const root = resolve(import.meta.dirname, "..");
const API_ROOT = "https://api.themoviedb.org/3";
const IMAGE_ROOT = "https://image.tmdb.org/t/p/w185";
// build-portraits.mjs republishes this suffix verbatim and its test pins the shape: an exotic path would break the index.
const PROFILE_SUFFIX = /^\/[A-Za-z0-9]+\.(?:jpg|png)$/;

export function parseYearRange(value, { defaultFrom = 2005, defaultTo = new Date().getUTCFullYear() } = {}) {
  const match = String(value ?? "").trim().match(/^(\d{4})(?:\s*(?:-|–|\.\.)\s*(\d{4}))?$/);
  if (!match) return { from: defaultFrom, to: defaultTo };
  const from = Number(match[1]);
  const to = match[2] ? Number(match[2]) : from;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

// createTmdbClient owns the person endpoints and stays a narrow adapter for the game server; discovery is an import-time
// concern, so its two endpoints live here rather than widening the shipped surface.
export function createDiscoveryClient({ token = process.env.TMDB_API_TOKEN, apiKey = process.env.TMDB_API_KEY, fetchImpl = globalThis.fetch, locale = "fr-FR" } = {}) {
  async function request(path, parameters = {}) {
    const url = new URL(`${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    if (apiKey && !token) url.searchParams.set("api_key", apiKey);
    const response = await fetchImpl(url, { headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const error = new Error(`TMDb a répondu ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  return {
    configured: Boolean(token || apiKey),
    async discoverMovies({ year, page = 1, minVotes = 100, originalLanguage = "fr" }) {
      const payload = await request("/discover/movie", {
        language: locale,
        include_adult: "false",
        include_video: "false",
        page,
        sort_by: "popularity.desc",
        with_original_language: originalLanguage,
        "vote_count.gte": minVotes,
        "primary_release_date.gte": `${year}-01-01`,
        "primary_release_date.lte": `${year}-12-31`,
      });
      return (payload.results ?? []).filter((movie) => movie?.id).map((movie) => ({
        id: Number(movie.id),
        title: movie.title ?? movie.original_title ?? "",
        year: Number(String(movie.release_date ?? "").slice(0, 4)) || year,
        popularity: Number(movie.popularity ?? 0),
      }));
    },
    async getMovieCredits(movieId) {
      const payload = await request(`/movie/${movieId}/credits`, { language: locale });
      return (payload.cast ?? []).filter((entry) => entry?.id && entry.name).map((entry, index) => ({
        id: Number(entry.id),
        name: String(entry.name),
        originalName: entry.original_name ? String(entry.original_name) : null,
        department: String(entry.known_for_department ?? "Acting"),
        adult: entry.adult === true,
        order: Number.isFinite(entry.order) ? Number(entry.order) : index,
      }));
    },
  };
}

// Deterministic walk: page by page, and inside a page the years from the most recent backwards, films by popularity
// then TMDb id, cast by billing order then id. A budgeted wave therefore spreads over the whole window instead of
// exhausting 2005 first, and the years where the catalogue is thinnest are met first. Facing the same TMDb answers,
// two runs meet the same candidates in the same sequence.
async function* walkCandidates({ discovery, years, pages, minVotes, originalLanguage, castDepth, seen }) {
  const exhausted = new Set();
  for (let page = 1; page <= pages; page += 1) {
    for (let year = years.to; year >= years.from; year -= 1) {
      if (exhausted.has(year)) continue;
      const movies = await discovery.discoverMovies({ year, page, minVotes, originalLanguage });
      if (!movies.length) {
        exhausted.add(year);
        continue;
      }
      for (const movie of [...movies].sort((left, right) => right.popularity - left.popularity || left.id - right.id)) {
        if (seen.movies.has(movie.id)) continue;
        seen.movies.add(movie.id);
        const cast = await discovery.getMovieCredits(movie.id);
        for (const entry of [...cast].sort((left, right) => left.order - right.order || left.id - right.id)) {
          if (entry.order >= castDepth || entry.adult) continue;
          yield { movie, entry };
        }
      }
    }
  }
}

function knownIdentities({ snapshot, overlay }) {
  const tmdbIds = new Set();
  const nameKeysSeen = new Set();
  const addName = (value) => {
    for (const key of nameKeys(value)) if (key) nameKeysSeen.add(key);
  };
  for (const person of snapshot.people ?? []) {
    if (person.externalIds?.tmdb) tmdbIds.add(String(person.externalIds.tmdb));
    addName(person.name);
    for (const alias of person.aliases ?? []) addName(alias);
  }
  for (const person of overlay.people ?? []) {
    if (person.externalIds?.tmdb) tmdbIds.add(String(person.externalIds.tmdb));
    addName(person.name);
    for (const alias of person.aliases ?? []) addName(alias);
  }
  return { tmdbIds, nameKeys: nameKeysSeen };
}

function workIndex(snapshot) {
  const byKey = new Map();
  const push = (key, id) => {
    if (!key) return;
    const bucket = byKey.get(key) ?? [];
    if (!bucket.includes(id)) bucket.push(id);
    byKey.set(key, bucket);
  };
  for (const work of snapshot.works ?? []) {
    for (const title of [work.title, work.originalTitle, ...(work.aliases ?? [])]) {
      push(strictIdentityKey(title), work.id);
      push(normalizeText(title), work.id);
    }
  }
  return byKey;
}

function usefulAliases(person, { max = 6 } = {}) {
  const keys = new Set([normalizeText(person.name)]);
  const kept = [];
  for (const alias of person.aliases ?? []) {
    const key = normalizeText(alias);
    // A transliteration into a non-Latin script normalises to nothing, and a spelling that folds onto the name indexes
    // no new key: both would only weigh the snapshot down.
    if (!key || keys.has(key)) continue;
    keys.add(key);
    kept.push(alias);
    if (kept.length >= max) break;
  }
  return kept;
}

function profileSuffix(profilePath) {
  const value = String(profilePath ?? "");
  if (!value.startsWith(`${IMAGE_ROOT}/`)) return null;
  const suffix = value.slice(IMAGE_ROOT.length);
  return PROFILE_SUFFIX.test(suffix) ? suffix : null;
}

async function writeJson(path, value) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`);
  await rename(temporaryPath, path);
}

export async function importTmdbCast({
  snapshotPath = resolve(root, "src/data/cinema-knowledge.json"),
  overlayPath = resolve(root, "src/data/tmdb-overlay.json"),
  snapshotOutputPath = resolve(root, "src/data/cinema-knowledge.local.json"),
  overlayOutputPath = resolve(root, "src/data/tmdb-overlay.local.json"),
  token = process.env.TMDB_API_TOKEN,
  apiKey = process.env.TMDB_API_KEY,
  fetchImpl = globalThis.fetch,
  years = null,
  pages = 2,
  limit = 60,
  minVotes = 100,
  castDepth = 8,
  creditsPerPerson = 60,
  originalLanguage = "fr",
  locale = "fr-FR",
  delayMs = 0,
  dryRun = false,
  log = () => {},
} = {}) {
  const range = parseYearRange(years);
  const budget = Math.max(0, Number(limit) || 0);
  // One pacer for every endpoint the wave touches, discovery and person alike: TMDb sees a single well-behaved caller.
  let nextRequestAt = 0;
  const pacedFetch = !delayMs ? fetchImpl : async (...call) => {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
    nextRequestAt = Date.now() + delayMs;
    return fetchImpl(...call);
  };
  const discovery = createDiscoveryClient({ token, apiKey, fetchImpl: pacedFetch, locale });
  const tmdb = createTmdbClient({ token, apiKey, fetchImpl: pacedFetch });
  // Resuming reads the file the previous wave wrote, exactly like the incremental sync; in CI input and output are the same file.
  const snapshot = JSON.parse(await readFile(existsSync(snapshotOutputPath) ? snapshotOutputPath : snapshotPath, "utf8"));
  const overlay = JSON.parse(await readFile(existsSync(overlayOutputPath) ? overlayOutputPath : overlayPath, "utf8"));
  overlay.people ??= [];
  overlay.works ??= [];
  overlay.failures ??= [];
  if (overlay.version !== 2) throw new Error("L’overlay TMDb source doit respecter le schéma compact v2.");
  if (overlay.baseSnapshotId !== snapshot.snapshotId) throw new Error(`L’overlay décrit ${overlay.baseSnapshotId} alors que le snapshot est ${snapshot.snapshotId}.`);

  const known = knownIdentities({ snapshot, overlay });
  const titleKeys = workIndex(snapshot);
  const snapshotWorksById = new Map((snapshot.works ?? []).map((work) => [work.id, work]));
  const snapshotPeopleById = new Map((snapshot.people ?? []).map((person) => [person.id, person]));
  const overlayWorksById = new Map(overlay.works.map((work) => [work.id, work]));
  const report = {
    years: range,
    pages,
    limit: budget,
    minVotes,
    dryRun: Boolean(dryRun),
    films: 0,
    castSeen: 0,
    added: [],
    newWorks: 0,
    skipped: { knownById: 0, knownByName: 0, notActing: 0, withoutFilm: 0, alreadyQueued: 0, idCollision: 0 },
    failures: [],
    written: false,
  };
  const seen = { movies: new Set(), people: new Set() };
  const addedPeople = [];
  const addedWorks = [];

  for await (const { movie, entry } of walkCandidates({ discovery, years: range, pages, minVotes, originalLanguage, castDepth, seen })) {
    if (report.added.length >= budget) break;
    report.films = seen.movies.size;
    report.castSeen += 1;
    if (seen.people.has(entry.id)) {
      report.skipped.alreadyQueued += 1;
      continue;
    }
    seen.people.add(entry.id);
    // TMDb's own answer to « is this person an actor »: a crew member billed for a cameo is not what a table names.
    // The count is reported so a first real wave can tell whether the rule turns away comedians it should have kept.
    if (entry.department !== "Acting") {
      report.skipped.notActing += 1;
      continue;
    }
    if (known.tmdbIds.has(String(entry.id))) {
      report.skipped.knownById += 1;
      continue;
    }
    if ([entry.name, entry.originalName].some((value) => nameKeys(value).some((key) => known.nameKeys.has(key)))) {
      report.skipped.knownByName += 1;
      continue;
    }
    let remote;
    try {
      remote = await tmdb.getPerson(entry.id, { locale });
    } catch (error) {
      report.failures.push({ tmdbId: entry.id, name: entry.name, reason: error.message });
      continue;
    }
    // The billing block and the person record can disagree on the spelling: re-check the canonical name and its aliases.
    if ([remote.name, ...(remote.aliases ?? [])].some((value) => nameKeys(value).some((key) => known.nameKeys.has(key)))) {
      report.skipped.knownByName += 1;
      continue;
    }
    // Le support ne suffit pas : chez TMDb un documentaire d'archives est un « movie », et l'importer comme film
    // reviendrait à graver dans le snapshot embarqué les liaisons que le jeu refuse désormais en ligne.
    const films = (remote.credits ?? [])
      .filter((credit) => isWorkInScope(credit, CORE_SCOPE) && (credit.roles ?? []).includes("acting") && credit.title)
      .sort((left, right) => (right.year ?? 0) - (left.year ?? 0) || left.title.localeCompare(right.title, "fr") || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, creditsPerPerson));
    if (!films.length) {
      report.skipped.withoutFilm += 1;
      continue;
    }
    const localPersonId = stableId("person", normalizeText(remote.name));
    if (snapshotPeopleById.has(localPersonId)) {
      report.skipped.idCollision += 1;
      report.failures.push({ tmdbId: entry.id, name: remote.name, reason: `Identifiant local ${localPersonId} déjà pris.` });
      continue;
    }

    const credits = [];
    for (const film of films) {
      const strictKey = strictIdentityKey(film.title);
      const looseKey = normalizeText(film.title);
      const candidateId = [...(titleKeys.get(strictKey) ?? []), ...(titleKeys.get(looseKey) ?? [])]
        .find((workId) => {
          const work = snapshotWorksById.get(workId);
          return work && (!work.year || !film.year || Number(work.year) === Number(film.year));
        });
      if (candidateId) {
        credits.push(candidateId);
        continue;
      }
      // Le rapprochement vient d'écarter toutes les œuvres de ce titre parce que leur année contredit celle du
      // crédit. Retomber sur stableId(strictKey) rendrait exactement l'identifiant qu'on vient de refuser, et le
      // crédit irait au remake au lieu du film. On désambiguïse alors par l'année, comme le fait déjà la base.
      const contradictsYear = (id) => {
        const work = snapshotWorksById.get(id);
        return Boolean(work && work.year && film.year && Number(work.year) !== Number(film.year));
      };
      const baseWorkId = stableId("work", strictKey);
      const workId = contradictsYear(baseWorkId) ? stableId("work", `${strictKey}:${film.year ?? ""}`) : baseWorkId;
      if (contradictsYear(workId)) {
        report.failures.push({ tmdbId: entry.id, name: remote.name, reason: `Identifiant ${workId} déjà pris par une autre année pour « ${film.title} ».` });
        continue;
      }
      if (!snapshotWorksById.has(workId)) {
        const work = {
          id: workId,
          title: film.title,
          originalTitle: film.originalTitle && film.originalTitle !== film.title ? film.originalTitle : null,
          aliases: [],
          year: film.year ?? null,
          type: "movie",
          kind: workKind(film),
          externalIds: { ...(film.externalIds?.tmdbMovie ? { tmdbMovie: film.externalIds.tmdbMovie } : {}) },
          source: "tmdb-import",
        };
        snapshotWorksById.set(workId, work);
        addedWorks.push(work);
        for (const title of [work.title, work.originalTitle]) {
          for (const key of [strictIdentityKey(title), normalizeText(title)]) {
            if (!key) continue;
            const bucket = titleKeys.get(key) ?? [];
            if (!bucket.includes(workId)) bucket.push(workId);
            titleKeys.set(key, bucket);
          }
        }
      }
      credits.push(workId);
    }

    const aliases = usefulAliases(remote);
    const localPerson = {
      id: localPersonId,
      name: remote.name,
      aliases,
      roles: ["acting"],
      // Discovery only ever looked at films shot in French: the French Touch theme is exactly the set this widens.
      tags: originalLanguage === "fr" ? ["fr"] : [],
      birthYear: remote.birthYear ?? null,
      deathYear: remote.deathYear ?? null,
      profilePath: null,
      popularity: [...new Set(credits)].length,
      externalIds: { ...remote.externalIds },
      credits: [...new Set(credits)],
      source: "tmdb-import",
    };
    const suffix = profileSuffix(remote.profilePath);
    const overlayPerson = {
      id: remote.id,
      name: remote.name,
      aliases: remote.aliases ?? [],
      roles: remote.roles ?? ["acting"],
      tags: [],
      birthYear: remote.birthYear ?? null,
      deathYear: remote.deathYear ?? null,
      profilePath: suffix ? `${IMAGE_ROOT}${suffix}` : null,
      popularity: remote.popularity ?? 0,
      externalIds: { ...remote.externalIds },
      credits: [],
      source: "tmdb",
      localPersonId,
      matchedBy: "tmdb-cast-import",
      syncedAt: new Date().toISOString(),
    };
    for (const credit of remote.credits ?? []) {
      // Same fold as the incremental sync: the freshest payload wins on the fields, aliases and roles accumulate.
      const previous = overlayWorksById.get(credit.id);
      overlayWorksById.set(credit.id, previous ? {
        ...previous,
        ...credit,
        aliases: [...new Set([...(previous.aliases ?? []), ...(credit.aliases ?? [])])],
        roles: [...new Set([...(previous.roles ?? []), ...(credit.roles ?? [])])],
        externalIds: { ...previous.externalIds, ...credit.externalIds },
      } : { ...credit });
      overlayPerson.credits.push(credit.id);
    }
    overlayPerson.credits = [...new Set(overlayPerson.credits)];

    snapshotPeopleById.set(localPersonId, localPerson);
    addedPeople.push({ localPerson, overlayPerson });
    known.tmdbIds.add(String(entry.id));
    for (const value of [remote.name, ...aliases]) for (const key of nameKeys(value)) known.nameKeys.add(key);
    report.added.push({ id: localPersonId, name: remote.name, tmdbId: entry.id, credits: localPerson.credits.length, discoveredIn: movie.title, discoveredYear: movie.year });
    log(`[${report.added.length}/${budget}] ${remote.name} · ${localPerson.credits.length} films · repéré dans ${movie.title} (${movie.year})`);
  }

  report.films = seen.movies.size;
  report.newWorks = addedWorks.length;
  if (!addedPeople.length) return report;
  if (dryRun) return report;

  const importedAt = new Date().toISOString();
  snapshot.people = [...(snapshot.people ?? []), ...addedPeople.map((entry) => entry.localPerson)];
  snapshot.works = [...(snapshot.works ?? []), ...addedWorks];
  snapshot.sources = [...(snapshot.sources ?? []).filter((source) => source.id !== "tmdb-cast-import"), { id: "tmdb-cast-import", importedAt }];
  // The snapshot ID keeps naming the canonical build: cinema-quality.json and the merge log are keyed on it and this
  // importer owns neither. Only the counters it invalidates are brought back in line.
  snapshot.quality = {
    ...(snapshot.quality ?? {}),
    people: snapshot.people.length,
    works: snapshot.works.length,
    credits: snapshot.people.reduce((sum, person) => sum + (person.credits?.length ?? 0), 0),
    aliases: snapshot.people.reduce((sum, person) => sum + (person.aliases?.length ?? 0), 0) + snapshot.works.reduce((sum, work) => sum + (work.aliases?.length ?? 0), 0),
  };
  overlay.people = [...overlay.people, ...addedPeople.map((entry) => entry.overlayPerson)];
  overlay.works = [...overlayWorksById.values()].sort((left, right) => left.id.localeCompare(right.id));
  overlay.generatedAt = importedAt;
  overlay.stats = {
    people: overlay.people.length,
    works: overlay.works.length,
    credits: overlay.people.reduce((sum, person) => sum + (person.credits?.length ?? 0), 0),
  };
  await writeJson(snapshotOutputPath, snapshot);
  await writeJson(overlayOutputPath, overlay);
  report.written = true;
  report.snapshot = { people: snapshot.people.length, works: snapshot.works.length, credits: snapshot.quality.credits };
  report.overlay = { ...overlay.stats };
  return report;
}

export function formatReport(report) {
  const lines = [
    `Fenêtre ${report.years.from}-${report.years.to}, ${report.pages} page(s) par année, plancher de ${report.minVotes} votes.`,
    `${report.films} films lus, ${report.castSeen} rôles principaux examinés.`,
    `${report.added.length} identité(s) ajoutée(s), ${report.newWorks} œuvre(s) inédite(s).`,
    `Ignorés — déjà connus par identifiant TMDb: ${report.skipped.knownById}, par nom: ${report.skipped.knownByName}, hors métier d’acteur: ${report.skipped.notActing}, sans film: ${report.skipped.withoutFilm}, revus dans la même vague: ${report.skipped.alreadyQueued}, identifiant local déjà pris: ${report.skipped.idCollision}.`,
  ];
  for (const person of report.added) lines.push(`  + ${person.name} (tmdb:${person.tmdbId}) · ${person.credits} films · ${person.discoveredIn} (${person.discoveredYear})`);
  for (const failure of report.failures) lines.push(`  ! ${failure.name} (tmdb:${failure.tmdbId}): ${failure.reason}`);
  if (report.dryRun) lines.push("Répétition générale: aucun fichier écrit.");
  else if (!report.written) lines.push("Catalogue déjà à jour: aucun fichier écrit.");
  else lines.push(`Écrit: ${report.snapshot.people} personnes et ${report.snapshot.works} œuvres au snapshot, ${report.overlay.people} personnes et ${report.overlay.works} œuvres à l’overlay.`);
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsMap = new Map(process.argv.slice(2).map((argument) => {
    const [key, ...value] = argument.replace(/^--/, "").split("=");
    return [key, value.join("=") || true];
  }));
  const client = createDiscoveryClient();
  if (!client.configured) {
    console.error("Configure TMDB_API_TOKEN (recommandé) ou TMDB_API_KEY avant de lancer l’import.");
    process.exitCode = 1;
  } else {
    const resolvePath = (key, fallback) => resolve(root, String(argumentsMap.get(key) ?? fallback));
    const report = await importTmdbCast({
      snapshotPath: resolvePath("snapshot", "src/data/cinema-knowledge.json"),
      overlayPath: resolvePath("overlay", "src/data/tmdb-overlay.json"),
      snapshotOutputPath: resolvePath("snapshot-out", "src/data/cinema-knowledge.local.json"),
      overlayOutputPath: resolvePath("overlay-out", "src/data/tmdb-overlay.local.json"),
      years: argumentsMap.has("years") ? String(argumentsMap.get("years")) : null,
      pages: Math.max(1, Number(argumentsMap.get("pages") ?? 2)),
      limit: Math.max(0, Number(argumentsMap.get("limit") ?? 60)),
      minVotes: Math.max(0, Number(argumentsMap.get("min-votes") ?? 100)),
      castDepth: Math.max(1, Number(argumentsMap.get("cast") ?? 8)),
      creditsPerPerson: Math.max(1, Number(argumentsMap.get("credits") ?? 60)),
      originalLanguage: String(argumentsMap.get("original-language") ?? "fr"),
      delayMs: Math.max(0, Number(argumentsMap.get("delay") ?? 150)),
      dryRun: argumentsMap.has("dry-run"),
      log: (line) => console.log(line),
    });
    console.log(formatReport(report));
  }
}
