import { normalizeText } from "../game/identity.js";
import {
  classifyWikidataFilm,
  classifyWikipediaCategories,
  CORE_KINDS,
  isKnownKind,
  isWorkInScope,
  WORK_KINDS,
} from "../game/work-kinds.js";

export const VERIFICATION_VERDICTS = Object.freeze({
  CONFIRMED: "CONFIRMED",
  PROBABLE: "PROBABLE",
  NOT_FOUND: "NOT_FOUND",
  UNKNOWN: "UNKNOWN",
});

const DEFAULT_USER_AGENT = "CineFil/1.0 (https://github.com/napolocreed/Cinefile_beta)";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const QLEVER_ENDPOINT = "https://qlever.dev/api/wikidata";
const WDQS_ENDPOINT = "https://query.wikidata.org/sparql";
const WIKIPEDIA_LANGUAGES = ["fr", "en"];
const CREDIT_PROPERTIES = ["P161", "P57", "P58", "P86", "P162", "P344", "P1040"];

function createTtlCache({ now = Date.now, max = 500 } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
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
    get size() {
      return entries.size;
    },
  };
}

function cleanName(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function numericId(value) {
  const id = String(value ?? "").replace(/^tmdb:/, "");
  return /^\d{1,12}$/.test(id) ? id : null;
}

// Le périmètre entre dans la clé de cache : deux tables qui ne jouent pas les mêmes extensions ne posent pas la
// même question, et servir à l'une la réponse de l'autre rendrait la règle inapplicable dès le second joueur.
function pairKey(left, right, leftTmdbId, rightTmdbId, locale, scope) {
  return [
    `${normalizeText(left)}#${numericId(leftTmdbId) ?? ""}`,
    `${normalizeText(right)}#${numericId(rightTmdbId) ?? ""}`,
  ].sort().join("|") + `|${locale}|${[...scope].sort().join("+")}`;
}

// Le périmètre demandé par le client, réduit à ce qui existe. Une requête muette — un vieux client, un appel à la
// main — joue le socle : c'est la lecture stricte, celle qui ne valide que du cinéma.
export function parseScope(value) {
  const requested = String(value ?? "").split(/[\s,+]+/).filter(isKnownKind);
  return new Set([...CORE_KINDS, ...requested]);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function decodeSnippet(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

function qidFromUri(value) {
  return String(value ?? "").match(/\/entity\/(Q\d+)$/)?.[1] ?? null;
}

function wikipediaUrl(language, title) {
  return `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

export function createVerificationSearchLinks(left, right) {
  const quoted = `"${left}" "${right}" film`;
  const query = encodeURIComponent(quoted);
  return {
    google: `https://www.google.com/search?q=${query}`,
    duckduckgo: `https://duckduckgo.com/?q=${query}`,
    qwant: `https://www.qwant.com/?q=${query}`,
    wikipedia: `https://fr.wikipedia.org/w/index.php?search=${query}`,
  };
}

// Q11424 « film » a pour sous-classes Q93204 « film documentaire » et Q506240 « téléfilm ». Une requête qui
// descend la chaîne des sous-classes — et il faut qu'elle la descende, sinon la moitié des vrais films manquent à
// l'appel — ramène donc forcément les deux. Plutôt que de les exclure d'entrée, on les fait nommer par la requête
// elle-même : la cascade trouve tout, et c'est la lecture qui décide de ce que la table accepte.
const WIKIDATA_FILM = "Q11424";
const WIKIDATA_DOCUMENTARY_FILM = "Q93204";
const WIKIDATA_TELEVISION_FILM = "Q506240";

function sharedFilmQuery(leftQids, rightQids) {
  const qids = (values) => values.map((qid) => `wd:${qid}`).join(" ");
  const properties = CREDIT_PROPERTIES.map((property) => `wdt:${property}`).join(" ");
  return `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?film ?filmLabel ?year ?left ?right ?documentary ?television WHERE {
  VALUES ?left { ${qids(leftQids)} }
  VALUES ?right { ${qids(rightQids)} }
  VALUES ?leftProperty { ${properties} }
  VALUES ?rightProperty { ${properties} }
  ?film ?leftProperty ?left ; ?rightProperty ?right ; wdt:P31/wdt:P279* wd:${WIKIDATA_FILM} .
  FILTER (?left != ?right)
  BIND(EXISTS { ?film wdt:P31/wdt:P279* wd:${WIKIDATA_DOCUMENTARY_FILM} } AS ?documentary)
  BIND(EXISTS { ?film wdt:P31/wdt:P279* wd:${WIKIDATA_TELEVISION_FILM} } AS ?television)
  OPTIONAL { ?film wdt:P577 ?date . BIND(YEAR(?date) AS ?year) }
  OPTIONAL { ?film rdfs:label ?labelFr . FILTER(LANG(?labelFr) = "fr") }
  OPTIONAL { ?film rdfs:label ?labelEn . FILTER(LANG(?labelEn) = "en") }
  BIND(COALESCE(?labelFr, ?labelEn) AS ?filmLabel)
}
LIMIT 20`.trim();
}

const sparqlBoolean = (binding) => binding?.value === "true" || binding?.value === "1";

function classifyFilmsQuery(qids) {
  return `
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT DISTINCT ?film WHERE {
  VALUES ?film { ${qids.map((qid) => `wd:${qid}`).join(" ")} }
  ?film wdt:P31/wdt:P279* wd:Q11424 .
}`.trim();
}

// Le support fait partie de l'identité : une série et un film peuvent porter le même titre la même année, et les
// confondre ici reviendrait à recréer, dans la cascade, la fusion que la base vient d'apprendre à refuser.
function tmdbWorkKey(work) {
  const id = work.externalIds?.tmdbMovie ?? work.externalIds?.tmdbTv;
  const type = work.type === "tv" ? "tv" : "movie";
  if (id) return `tmdb:${type}:${id}`;
  return `${type}:${normalizeText(work.title)}:${work.year ?? ""}`;
}

// Le filtre portait sur le support — « type movie » — quand il devait porter sur la nature. C'est ce qui laissait
// passer les documentaires d'archives, qui sont des « movies » chez TMDb et où deux acteurs se croisent sans
// s'être jamais rencontrés.
function intersectTmdbPeople(leftPeople, rightPeople, scope) {
  const matches = new Map();
  const playable = (work) => isWorkInScope(work, scope);
  for (const left of leftPeople) {
    const leftWorks = new Map((left.credits ?? []).filter(playable).map((work) => [tmdbWorkKey(work), work]));
    for (const right of rightPeople) {
      if (String(left.externalIds?.tmdb) === String(right.externalIds?.tmdb)) continue;
      for (const work of (right.credits ?? []).filter(playable)) {
        const shared = leftWorks.get(tmdbWorkKey(work));
        if (!shared) continue;
        const key = tmdbWorkKey(shared);
        matches.set(key, {
          title: shared.title,
          year: shared.year ?? work.year ?? null,
          kind: shared.kind ?? work.kind ?? WORK_KINDS.UNKNOWN,
          url: shared.externalIds?.tmdbMovie ? `https://www.themoviedb.org/movie/${shared.externalIds.tmdbMovie}` : null,
          source: "tmdb",
          leftResolved: left.name,
          rightResolved: right.name,
        });
      }
    }
  }
  return [...matches.values()].slice(0, 20);
}

function resultTtl(verdict) {
  if (verdict === VERIFICATION_VERDICTS.CONFIRMED) return 24 * 60 * 60_000;
  if (verdict === VERIFICATION_VERDICTS.PROBABLE) return 6 * 60 * 60_000;
  if (verdict === VERIFICATION_VERDICTS.NOT_FOUND) return 60 * 60_000;
  return 5 * 60_000;
}

export function createLinkVerifier({
  tmdb = null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = 6_000,
  // `timeoutMs` ne borne qu'une requête isolée. Rien ne bornait la cascade : Wikipédia parcourait ses langues l'une
  // après l'autre et chaque interrogation Wikidata essaie deux endpoints SPARQL en série, si bien que les délais
  // s'additionnaient — mesuré à quatre fois le timeout unitaire. Le jeu restait bloqué sur « Consultation des
  // archives » sans abandon possible, et comme le verdict tombait en UNKNOWN, la lenteur se rejouait au tour suivant.
  maxVerificationMs = 12_000,
  networkEnabled = process.env.VERIFY_LINK_NETWORK !== "0",
  maxConcurrentUpstream = 12,
} = {}) {
  const resultCache = createTtlCache({ now, max: 1_000 });
  const identityCache = createTtlCache({ now, max: 2_000 });
  const inFlight = new Map();
  const metrics = {
    requests: 0,
    cacheHits: 0,
    coalesced: 0,
    verdicts: { CONFIRMED: 0, PROBABLE: 0, NOT_FOUND: 0, UNKNOWN: 0 },
    sources: { tmdb: 0, wikidata: 0, wikipedia: 0, none: 0 },
    upstreamErrors: { tmdb: 0, wikidata: 0, wikipedia: 0 },
    upstreamRejected: 0,
    latencies: [],
  };
  const upstreamLimit = Math.max(1, Math.min(50, Number(maxConcurrentUpstream) || 12));
  let activeUpstream = 0;

  // Le compteur ne vivait que dans fetchJson — donc Wikidata et Wikipédia seulement. TMDb, la seule source à quota,
  // passait à côté : quinze vérifications parallèles y lançaient soixante appels sans aucune borne. Le garde-fou est
  // donc sorti de fetchJson pour couvrir aussi les appels TMDb.
  async function withUpstreamSlot(run) {
    if (activeUpstream >= upstreamLimit) {
      metrics.upstreamRejected += 1;
      throw Object.assign(new Error("upstream-overloaded"), { code: "UPSTREAM_OVERLOADED" });
    }
    activeUpstream += 1;
    try {
      return await run();
    } finally {
      activeUpstream -= 1;
    }
  }

  async function fetchJson(url, { accept = "application/json", timeout = timeoutMs } = {}) {
    if (!networkEnabled || !fetchImpl) throw Object.assign(new Error("network-disabled"), { code: "NETWORK_DISABLED" });
    return withUpstreamSlot(async () => {
      const response = await fetchImpl(url, {
        headers: { Accept: accept, "User-Agent": userAgent },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        const error = new Error(`upstream-${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers?.get?.("retry-after") ?? null;
        throw error;
      }
      return response.json();
    });
  }

  async function querySparql(query) {
    const failures = [];
    for (const endpoint of [QLEVER_ENDPOINT, WDQS_ENDPOINT]) {
      const url = new URL(endpoint);
      url.searchParams.set("query", query);
      if (endpoint === WDQS_ENDPOINT) url.searchParams.set("format", "json");
      try {
        return { payload: await fetchJson(url, { accept: "application/sparql-results+json" }), endpoint };
      } catch (error) {
        failures.push({ endpoint, error });
      }
    }
    throw Object.assign(new Error("sparql-unavailable"), { failures });
  }

  async function resolveWikidata(name, language = "fr") {
    const key = `${language}:${normalizeText(name)}`;
    const cached = identityCache.get(key);
    if (cached !== undefined) return cached;
    const url = new URL(WIKIDATA_API);
    url.search = new URLSearchParams({
      action: "wbsearchentities",
      search: name,
      language,
      uselang: language,
      type: "item",
      limit: "5",
      format: "json",
      origin: "*",
    });
    const payload = await fetchJson(url);
    const candidates = (payload.search ?? [])
      .filter((candidate) => /^Q\d+$/.test(candidate.id))
      .slice(0, 5)
      .map((candidate) => ({ id: candidate.id, label: candidate.label ?? name, matchedText: candidate.match?.text ?? null, description: candidate.description ?? null }));
    const selectedCandidates = candidates.filter((candidate) => [candidate.label, candidate.matchedText].some((value) => normalizeText(value) === normalizeText(name))).slice(0, 5);
    identityCache.set(key, selectedCandidates, 7 * 24 * 60 * 60_000);
    return selectedCandidates;
  }

  async function resolveTmdbPeople(name, id) {
    if (!tmdb?.configured) return [];
    const explicitId = numericId(id);
    if (explicitId) return [await withUpstreamSlot(() => tmdb.getPerson(explicitId))];
    const candidates = await withUpstreamSlot(() => tmdb.searchPeople(name, { locale: "fr-FR", limit: 5 }));
    const exact = candidates.filter((candidate) => normalizeText(candidate.name) === normalizeText(name)).slice(0, 3);
    return Promise.all(exact.map((candidate) => withUpstreamSlot(() => tmdb.getPerson(candidate.externalIds.tmdb))));
  }

  async function verifyTmdb(left, right, leftTmdbId, rightTmdbId, scope) {
    if (!tmdb?.configured) return { status: "skipped", source: "tmdb" };
    try {
      const [leftPeople, rightPeople] = await Promise.all([
        resolveTmdbPeople(left, leftTmdbId),
        resolveTmdbPeople(right, rightTmdbId),
      ]);
      const films = intersectTmdbPeople(leftPeople, rightPeople, scope);
      return films.length
        ? { status: "ok", verdict: VERIFICATION_VERDICTS.CONFIRMED, source: "tmdb", films, evidence: films.slice(0, 5) }
        : { status: "ok", source: "tmdb", films: [] };
    } catch (error) {
      metrics.upstreamErrors.tmdb += 1;
      return { status: "error", source: "tmdb", error: error.code ?? error.status ?? "unavailable" };
    }
  }

  async function verifyWikidata(left, right, scope) {
    try {
      const [leftCandidates, rightCandidates] = await Promise.all([resolveWikidata(left), resolveWikidata(right)]);
      if (!leftCandidates.length || !rightCandidates.length) return { status: "ok", source: "wikidata", films: [] };
      const { payload, endpoint } = await querySparql(sharedFilmQuery(
        leftCandidates.map((candidate) => candidate.id),
        rightCandidates.map((candidate) => candidate.id),
      ));
      const filmsById = new Map();
      for (const binding of payload.results?.bindings ?? []) {
        const qid = qidFromUri(binding.film?.value);
        const title = binding.filmLabel?.value ?? qid;
        if (!qid || !title) continue;
        const previous = filmsById.get(qid);
        const incomingYear = Number(binding.year?.value) || null;
        const year = [previous?.year, incomingYear].filter(Boolean).sort((left, right) => left - right)[0] ?? null;
        filmsById.set(qid, {
          title,
          year,
          kind: classifyWikidataFilm({
            documentary: sparqlBoolean(binding.documentary),
            television: sparqlBoolean(binding.television),
          }),
          url: `https://www.wikidata.org/wiki/${qid}`,
          source: "wikidata",
          qid,
          leftQid: qidFromUri(binding.left?.value),
          rightQid: qidFromUri(binding.right?.value),
        });
      }
      const films = [...filmsById.values()].filter((film) => isWorkInScope(film, scope)).slice(0, 20);
      return films.length
        ? { status: "ok", verdict: VERIFICATION_VERDICTS.CONFIRMED, source: "wikidata", endpoint, films, evidence: films.slice(0, 5) }
        : { status: "ok", source: "wikidata", endpoint, films: [] };
    } catch (error) {
      metrics.upstreamErrors.wikidata += 1;
      return { status: "error", source: "wikidata", error: error.code ?? error.status ?? "unavailable" };
    }
  }

  async function searchWikipediaLanguage(language, left, right) {
    const api = `https://${language}.wikipedia.org/w/api.php`;
    const searchUrl = new URL(api);
    searchUrl.search = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: `"${left}" "${right}"`,
      srnamespace: "0",
      srlimit: "10",
      srprop: "snippet",
      format: "json",
      origin: "*",
    });
    const searchPayload = await fetchJson(searchUrl);
    const searchResults = searchPayload.query?.search ?? [];
    if (!searchResults.length) return [];
    const detailsUrl = new URL(api);
    detailsUrl.search = new URLSearchParams({
      action: "query",
      pageids: searchResults.map((entry) => entry.pageid).join("|"),
      prop: "pageprops|categories",
      ppprop: "wikibase_item",
      cllimit: "50",
      format: "json",
      origin: "*",
    });
    const detailsPayload = await fetchJson(detailsUrl);
    const details = new Map(Object.values(detailsPayload.query?.pages ?? {}).map((page) => [Number(page.pageid), page]));
    const qids = [...new Set([...details.values()].map((page) => page.pageprops?.wikibase_item).filter((qid) => /^Q\d+$/.test(qid)))];
    let filmQids = new Set();
    if (qids.length) {
      try {
        const { payload } = await querySparql(classifyFilmsQuery(qids));
        filmQids = new Set((payload.results?.bindings ?? []).map((binding) => qidFromUri(binding.film?.value)).filter(Boolean));
      } catch {
        // Category evidence below remains useful as a probable, never definitive, result.
      }
    }
    return searchResults.flatMap((entry) => {
      const page = details.get(Number(entry.pageid));
      const qid = page?.pageprops?.wikibase_item ?? null;
      const categories = (page?.categories ?? []).map((category) => category.title.replace(/^[^:]+:/, ""));
      const categoryLooksLikeFilm = categories.some((category) => {
        const filmCategory = /^(film\b|films\b|\d{4} films\b)/i.test(category);
        const professionCategory = /\b(actor|actress|director|producer|screenwriter|composer|editor|cinematographer|critics?|festival|award)\b/i.test(category);
        return filmCategory && !professionCategory;
      });
      if (!filmQids.has(qid) && !categoryLooksLikeFilm) return [];
      return [{
        title: entry.title,
        year: null,
        // « Film documentaire de 2016 » commence par « Film » : l'ancienne lecture n'y voyait qu'un film. Les
        // catégories, elles, disent souvent la nature en toutes lettres — c'est un indice, à la hauteur de ce que
        // vaut cette étape, qui n'a jamais le droit de valider seule.
        kind: classifyWikipediaCategories(categories),
        url: wikipediaUrl(language, entry.title),
        source: "wikipedia",
        language,
        qid,
        snippet: decodeSnippet(entry.snippet),
        classification: filmQids.has(qid) ? "wikidata-film" : "category-film",
      }];
    });
  }

  async function verifyWikipedia(left, right, scope) {
    try {
      // Les langues sont interrogées de front : elles sont indépendantes, et les enchaîner ajoutait un timeout
      // complet au budget de la cascade pour un gain nul.
      const settled = await Promise.allSettled(WIKIPEDIA_LANGUAGES.map((language) => searchWikipediaLanguage(language, left, right)));
      // Une langue qui échoue n'est pas une absence de preuve ; toutes qui échouent, si.
      if (settled.every((entry) => entry.status === "rejected")) throw settled[0].reason;
      const evidence = settled
        .flatMap((entry) => (entry.status === "fulfilled" ? entry.value : []))
        .filter((entry) => isWorkInScope(entry, scope));
      const uniqueEvidence = [...new Map(evidence.map((entry) => [`${entry.language}:${entry.title}`, entry])).values()].slice(0, 10);
      return uniqueEvidence.length
        ? { status: "ok", verdict: VERIFICATION_VERDICTS.PROBABLE, source: "wikipedia", films: uniqueEvidence.map(({ snippet, classification, language, qid, ...film }) => film), evidence: uniqueEvidence }
        : { status: "ok", source: "wikipedia", films: [] };
    } catch (error) {
      metrics.upstreamErrors.wikipedia += 1;
      return { status: "error", source: "wikipedia", error: error.code ?? error.status ?? "unavailable" };
    }
  }

  // Each source reports how its own attempt went, so the table can read the whole cascade afterwards and
  // see exactly where the proof came from — or that nobody ever looked.
  function describeStep(source, result, durationMs) {
    const outcome = result.status === "ok"
      ? ({ [VERIFICATION_VERDICTS.CONFIRMED]: "confirmed", [VERIFICATION_VERDICTS.PROBABLE]: "probable" })[result.verdict] ?? "empty"
      : result.status;
    return {
      source,
      outcome,
      durationMs: Math.max(0, Math.round(durationMs)),
      films: (result.films ?? []).length,
      error: result.error ?? null,
    };
  }

  async function timedStep(source, operation) {
    const startedAt = now();
    const result = await operation;
    return { result, step: describeStep(source, result, now() - startedAt) };
  }

  const unreachedStep = (source, outcome = "not-reached") => ({ source, outcome, durationMs: 0, films: 0, error: null });

  // Le budget total de la cascade. Les requêtes déjà parties continuent de se vider — chacune reste bornée par
  // `timeoutMs` — mais la table, elle, cesse d'attendre : sans preuve dans le temps imparti, la réponse est
  // « on ne sait pas », qui est exactement ce que la cascade aurait fini par dire.
  const verificationBudget = Math.max(timeoutMs, Number(maxVerificationMs) || timeoutMs * 2);

  async function performVerification(input) {
    let expire = null;
    const deadline = new Promise((_, reject) => {
      expire = setTimeout(() => reject(Object.assign(new Error("verification-deadline"), { code: "DEADLINE" })), verificationBudget);
    });
    try {
      return await Promise.race([runCascade(input), deadline]);
    } catch (error) {
      if (error?.code !== "DEADLINE") throw error;
      metrics.deadlines = (metrics.deadlines ?? 0) + 1;
      return {
        verdict: VERIFICATION_VERDICTS.UNKNOWN,
        source: "none",
        films: [],
        evidence: [],
        searchLinks: createVerificationSearchLinks(input.left, input.right),
        steps: [unreachedStep("tmdb", "abandoned"), unreachedStep("wikidata", "abandoned"), unreachedStep("wikipedia", "abandoned")],
        locale: input.locale,
        scope: [...input.scope].sort(),
      };
    } finally {
      clearTimeout(expire);
    }
  }

  async function runCascade({ left, right, leftTmdbId, rightTmdbId, locale, scope }) {
    const searchLinks = createVerificationSearchLinks(left, right);
    const tmdb = await timedStep("tmdb", verifyTmdb(left, right, leftTmdbId, rightTmdbId, scope));
    if (tmdb.result.verdict === VERIFICATION_VERDICTS.CONFIRMED) {
      return { ...tmdb.result, searchLinks, steps: [tmdb.step, unreachedStep("wikidata"), unreachedStep("wikipedia")] };
    }

    const wikidataPromise = timedStep("wikidata", verifyWikidata(left, right, scope));
    const wikipediaPromise = timedStep("wikipedia", verifyWikipedia(left, right, scope));
    const wikidata = await wikidataPromise;
    if (wikidata.result.verdict === VERIFICATION_VERDICTS.CONFIRMED) {
      // Wikipédia was searched in parallel but its answer is no longer needed.
      wikipediaPromise.catch(() => {});
      return { ...wikidata.result, searchLinks, steps: [tmdb.step, wikidata.step, unreachedStep("wikipedia", "abandoned")] };
    }
    const wikipedia = await wikipediaPromise;
    const steps = [tmdb.step, wikidata.step, wikipedia.step];
    if (wikipedia.result.verdict === VERIFICATION_VERDICTS.PROBABLE) {
      return { ...wikipedia.result, searchLinks, steps };
    }
    const attempted = [tmdb.result, wikidata.result, wikipedia.result].filter((result) => result.status !== "skipped");
    const verdict = !networkEnabled || attempted.some((result) => result.status === "error")
      ? VERIFICATION_VERDICTS.UNKNOWN
      : VERIFICATION_VERDICTS.NOT_FOUND;
    return {
      verdict,
      source: "none",
      films: [],
      evidence: [],
      searchLinks,
      steps,
      locale,
      scope: [...scope].sort(),
    };
  }

  async function verify(input = {}) {
    const left = cleanName(input.left);
    const right = cleanName(input.right);
    const locale = /^([a-z]{2})(-[A-Z]{2})?$/.test(String(input.locale ?? "fr-FR")) ? String(input.locale ?? "fr-FR") : "fr-FR";
    if (left.length < 2 || right.length < 2) throw Object.assign(new Error("Deux noms d’artistes sont requis."), { status: 400 });
    if (normalizeText(left) === normalizeText(right)) throw Object.assign(new Error("Les deux artistes doivent être différents."), { status: 400 });
    const scope = input.scope instanceof Set ? input.scope : parseScope(input.scope);
    const key = pairKey(left, right, input.leftTmdbId, input.rightTmdbId, locale, scope);
    metrics.requests += 1;
    const cached = resultCache.get(key);
    if (cached !== undefined) {
      metrics.cacheHits += 1;
      return { ...structuredClone(cached), cached: true };
    }
    if (inFlight.has(key)) {
      metrics.coalesced += 1;
      return inFlight.get(key);
    }
    const startedAt = now();
    const promise = performVerification({ left, right, leftTmdbId: input.leftTmdbId, rightTmdbId: input.rightTmdbId, locale, scope })
      .then((result) => {
        const durationMs = Math.max(0, now() - startedAt);
        const response = { ...result, left, right, durationMs, cached: false, scope: [...scope].sort() };
        metrics.verdicts[response.verdict] += 1;
        metrics.sources[response.source] = (metrics.sources[response.source] ?? 0) + 1;
        metrics.latencies.push(durationMs);
        if (metrics.latencies.length > 100) metrics.latencies.shift();
        resultCache.set(key, response, resultTtl(response.verdict));
        return structuredClone(response);
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  function status() {
    const averageMs = metrics.latencies.length
      ? Math.round(metrics.latencies.reduce((sum, value) => sum + value, 0) / metrics.latencies.length)
      : 0;
    return {
      enabled: networkEnabled,
      tmdbConfigured: Boolean(tmdb?.configured),
      cacheEntries: resultCache.size,
      identityCacheEntries: identityCache.size,
      requests: metrics.requests,
      cacheHits: metrics.cacheHits,
      coalesced: metrics.coalesced,
      verdicts: { ...metrics.verdicts },
      sources: { ...metrics.sources },
      upstreamErrors: { ...metrics.upstreamErrors },
      upstream: { active: activeUpstream, limit: upstreamLimit, rejected: metrics.upstreamRejected },
      latency: { averageMs, p95Ms: percentile(metrics.latencies, 0.95) },
    };
  }

  return { verify, status };
}
