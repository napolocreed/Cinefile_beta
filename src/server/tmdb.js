import { classifyTmdbCredit, WORK_KINDS } from "../game/work-kinds.js";

const API_ROOT = "https://api.themoviedb.org/3";
const IMAGE_ROOT = "https://image.tmdb.org/t/p/w185";

function yearFromDate(value) {
  const year = Number(String(value ?? "").slice(0, 4));
  return Number.isFinite(year) && year > 1800 ? year : null;
}

function ttlCache({ now = Date.now, max = 500 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > max) entries.delete(entries.keys().next().value);
    },
  };
}

export function createTmdbClient({ token = process.env.TMDB_API_TOKEN, apiKey = process.env.TMDB_API_KEY, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const configured = Boolean(token || apiKey);
  const cache = ttlCache({ now });

  async function request(path, parameters = {}) {
    if (!configured) {
      const error = new Error("TMDb n'est pas configuré.");
      error.code = "TMDB_NOT_CONFIGURED";
      throw error;
    }
    const url = new URL(`${API_ROOT}${path}`);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    if (apiKey && !token) url.searchParams.set("api_key", apiKey);
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const error = new Error(`TMDb a répondu ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async function searchPeople(query, { locale = "fr-FR", limit = 8, includeAdult = false } = {}) {
    const cacheKey = `search:${locale}:${includeAdult}:${query.toLocaleLowerCase("fr")}:${limit}`;
    const previous = cache.get(cacheKey);
    if (previous) return previous;
    const payload = await request("/search/person", { query, language: locale, include_adult: String(includeAdult), page: 1 });
    const results = (payload.results ?? []).slice(0, limit).map((person) => ({
      id: `tmdb:${person.id}`,
      name: person.name,
      aliases: [],
      roles: [String(person.known_for_department ?? "artist").toLowerCase()],
      tags: [],
      birthYear: null,
      profilePath: person.profile_path ? `${IMAGE_ROOT}${person.profile_path}` : null,
      popularity: Number(person.popularity ?? 0),
      externalIds: { tmdb: person.id },
      knownFor: (person.known_for ?? []).map((work) => work.title ?? work.name).filter(Boolean).slice(0, 3),
      creditCount: 0,
      origin: "tmdb",
      source: "tmdb",
    }));
    cache.set(cacheKey, results, 15 * 60_000);
    return results;
  }

  async function getPerson(personId, { locale = "fr-FR" } = {}) {
    const numericId = String(personId).replace(/^tmdb:/, "");
    if (!/^\d+$/.test(numericId)) throw new Error("Identifiant TMDb invalide.");
    const cacheKey = `person:${locale}:${numericId}`;
    const previous = cache.get(cacheKey);
    if (previous) return previous;
    const payload = await request(`/person/${numericId}`, { language: locale, append_to_response: "combined_credits,external_ids" });
    const works = new Map();
    const roles = new Set();
    // « movie » chez TMDb n'est pas « film de cinéma » : le même support porte les documentaires, les captations
    // de plateau et les téléfilms. Les genres sont la seule chose de la filmographie combinée qui les sépare, et
    // ils voyagent donc avec l'œuvre — c'est ce qui permet au jeu de choisir, plus tard et hors connexion, ce
    // qu'il accepte comme liaison.
    const addCredit = (credit, role) => {
      const title = credit.title ?? credit.name;
      if (!title || !credit.id) return;
      const type = credit.media_type === "tv" ? "tv" : "movie";
      const key = `${type}:${credit.id}`;
      const previousWork = works.get(key);
      const work = previousWork ?? {
        id: `tmdb-${type}:${credit.id}`,
        title,
        originalTitle: credit.original_title ?? credit.original_name ?? null,
        aliases: [],
        year: yearFromDate(credit.release_date ?? credit.first_air_date),
        type,
        kind: classifyTmdbCredit({ mediaType: credit.media_type, genreIds: credit.genre_ids }),
        genreIds: [...new Set((credit.genre_ids ?? []).map(Number).filter(Number.isFinite))],
        externalIds: type === "tv" ? { tmdbTv: credit.id } : { tmdbMovie: credit.id },
        source: "tmdb",
        roles: [],
      };
      // Une même œuvre revient une fois par métier, et TMDb ne renseigne pas toujours les genres sur chacune de
      // ces lignes : la première qui les porte fixe la nature, les suivantes ne la redescendent pas à l'inconnu.
      // La garde portait sur `kind === UNKNOWN`, structurellement inatteignable pour la télévision : une ligne tv
      // sans genres rend déjà « série ». Un talk-show dont la ligne muette arrivait en premier restait donc classé
      // série — et passait le périmètre d'une table qui avait ouvert les séries mais pas les plateaux. C'est
      // l'absence de genres, et non la nature obtenue, qui dit que la nature a été devinée.
      if (previousWork && !previousWork.genreIds.length && credit.genre_ids?.length) {
        previousWork.kind = classifyTmdbCredit({ mediaType: credit.media_type, genreIds: credit.genre_ids });
        previousWork.genreIds = [...new Set(credit.genre_ids.map(Number).filter(Number.isFinite))];
      }
      work.roles = [...new Set([...work.roles, role])];
      works.set(key, work);
      roles.add(role);
    };
    for (const credit of payload.combined_credits?.cast ?? []) addCredit(credit, "acting");
    for (const credit of payload.combined_credits?.crew ?? []) addCredit(credit, String(credit.department ?? credit.job ?? "crew").toLowerCase());
    const person = {
      id: `tmdb:${payload.id}`,
      name: payload.name,
      aliases: [...new Set(payload.also_known_as ?? [])].filter((alias) => alias !== payload.name),
      roles: [...roles].length ? [...roles] : [String(payload.known_for_department ?? "artist").toLowerCase()],
      tags: [],
      birthYear: yearFromDate(payload.birthday),
      deathYear: yearFromDate(payload.deathday),
      profilePath: payload.profile_path ? `${IMAGE_ROOT}${payload.profile_path}` : null,
      popularity: Number(payload.popularity ?? 0),
      externalIds: { tmdb: payload.id, ...(payload.external_ids?.imdb_id ? { imdb: payload.external_ids.imdb_id } : {}) },
      credits: [...works.values()],
      source: "tmdb",
    };
    cache.set(cacheKey, person, 24 * 60 * 60_000);
    return person;
  }

  return { configured, searchPeople, getPerson };
}
