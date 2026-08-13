import { normalizeText } from "../game/identity.js";
import { phoneticCode, phoneticNormalize, phoneticSimilarity, phoneticTokens } from "./phonetics.js";

// Words a player says around a name. They are dropped from one of the two tokenisations so that
// "Jean, je dirais, Dujardin" still produces the span "jean dujardin".
const FILLER_WORDS = new Set([
  "ah", "allez", "alors", "attends", "bah", "beh", "ben", "bon", "bref", "ca", "connais", "crois",
  "dirais", "dis", "dit", "donne", "du", "coup", "euh", "eh", "hein", "heu", "hum", "je", "j",
  "mets", "moi", "non", "ok", "oh", "oui", "ouais", "pense", "peut", "etre", "prends", "propose",
  "sais", "suivant", "tiens", "toi", "tour", "vais", "voila", "voir", "acteur", "actrice", "artiste",
  "cinema", "film", "films",
]);

// Words that may appear inside a name but can never be a name on their own.
const STOPWORDS = new Set([
  ...FILLER_WORDS,
  "a", "au", "aux", "avec", "avant", "apres", "aussi", "autre", "bien", "car", "ce", "cet", "cette",
  "chez", "comme", "comment", "dans", "de", "deja", "des", "donc", "elle", "en", "encore", "entre",
  "est", "et", "eux", "fait", "il", "ils", "jamais", "la", "le", "les", "leur", "lui", "mais", "me",
  "meme", "mes", "mon", "ne", "ni", "nous", "on", "ou", "par", "pas", "pendant", "plus", "por",
  "pour", "pourquoi", "quand", "que", "quel", "quelle", "qui", "quoi", "sa", "sans", "se", "ses",
  "si", "son", "sous", "sur", "ta", "te", "tes", "toujours", "tous", "tout", "toute", "tres", "tu",
  "un", "une", "vers", "vos", "votre", "vous", "y", "the", "and", "with",
]);

const MAX_SPAN_TOKENS = 4;
const MIN_SPAN_CODE = 3;
const MIN_MULTI_SCORE = 0.7;
const MIN_SINGLE_SCORE = 0.84;
// A surname alone identifies an artist far less than a full name does, and it must stay out of the top
// confidence band: hearing "Lellouche" is not hearing "Camille Lellouche".
const SURNAME_FACTOR = 0.86;
// A reading the recogniser itself doubts should not win over the one it proposed first.
const ALTERNATIVE_DECAY = 0.035;
const PARTIAL_PENALTY = 0.9;
const FRAGMENT_PENALTY = 0.55;
// TMDb ships 369 one-word aliases that are nicknames, not identities — "Camille" for Prince, "Simone" for Marion
// Cotillard, "Omar" for Omar Sy. They remain a legitimate way to name someone, but hearing one is never as good
// as hearing a name, and it must never look certain enough to hide the off-catalogue card.
const NICKNAME_PENALTY = 0.78;
const LINK_BONUS = 0.05;

function tailForms(tokens) {
  const tails = [];
  if (tokens.length >= 2) tails.push(tokens.at(-1));
  if (tokens.length >= 3) tails.push(tokens.slice(-2).join(""));
  return tails.filter((tail) => tail.length >= 3);
}

function personForms(person) {
  const forms = [];
  const seen = new Set();
  for (const [kind, value] of [["name", person.name], ...(person.aliases ?? []).map((alias) => ["alias", alias])]) {
    const tokens = phoneticTokens(value);
    if (!tokens.length) continue;
    const code = tokens.join("");
    if (code.length < MIN_SPAN_CODE || seen.has(code)) continue;
    seen.add(code);
    // "Sy, Omar" is a catalogue sort key: its last token is a given name, never a surname to match alone.
    const inverted = String(value).includes(",");
    forms.push({ kind, text: value, normalized: normalizeText(value), code, tokens: tokens.length, tails: inverted ? [] : tailForms(tokens) });
  }
  return forms;
}

function compareCodes(left, right) {
  const span = Math.max(left.length, right.length);
  if (!span) return 0;
  // A large length gap can never recover through edits; skipping it keeps the sweep cheap.
  if (Math.abs(left.length - right.length) / span > 0.4) return 0;
  return phoneticSimilarity(left, right);
}

function scoreSpanAgainstForm(span, form) {
  // A span that leaves informative words of the utterance unaccounted for is a partial reading: the player said
  // more than this name.
  const partial = span.informative < span.utterance;
  // Worse, a one-word catalogue name matched by one word of a longer sentence is almost always a coincidence of
  // vocabulary — "Camille" inside "Camille Chamoux" happens to be an alias of Prince. Such a fragment is damped
  // below the acceptance floor rather than merely demoted.
  const nickname = form.kind === "alias" && form.tokens === 1 ? NICKNAME_PENALTY : 1;
  const penalty = nickname * (partial ? (form.tokens === 1 ? FRAGMENT_PENALTY : PARTIAL_PENALTY) : 1);
  if (span.normalized === form.normalized) return { score: penalty, via: form.kind, exact: !partial };
  let score = compareCodes(span.code, form.code);
  let via = form.kind;
  for (const tail of form.tails) {
    const tailScore = compareCodes(span.code, tail) * SURNAME_FACTOR;
    if (tailScore > score) {
      score = tailScore;
      via = "surname";
    }
  }
  return { score: score * penalty, via, exact: false };
}

const isInformative = (token) => token.normalized.length > 1 && !STOPWORDS.has(token.normalized);

function pushSpan(spans, tokens, start, end) {
  const slice = tokens.slice(start, end);
  // "ah oui c'est bon" is a sentence, not a name: a span needs at least one word of its own.
  if (!slice.some(isInformative)) return;
  const code = slice.map((token) => token.code).join("");
  if (code.length < MIN_SPAN_CODE) return;
  const previous = spans.get(code);
  if (previous && previous.size >= slice.length) return;
  spans.set(code, {
    code,
    raw: slice.map((token) => token.raw).join(" "),
    normalized: slice.map((token) => token.normalized).join(" "),
    size: slice.length,
    informative: slice.filter(isInformative).length,
  });
}

function spansOf(transcript) {
  const words = phoneticNormalize(transcript).split(" ").filter(Boolean);
  if (!words.length) return { spans: [], informative: 0 };
  const tokens = words.map((word) => ({ raw: word, normalized: word, code: phoneticCode(word) })).filter((token) => token.code);
  const condensed = tokens.filter((token) => !FILLER_WORDS.has(token.normalized));
  const spans = new Map();
  for (const list of condensed.length && condensed.length !== tokens.length ? [tokens, condensed] : [tokens]) {
    for (let size = 1; size <= Math.min(MAX_SPAN_TOKENS, list.length); size += 1) {
      for (let start = 0; start + size <= list.length; start += 1) pushSpan(spans, list, start, start + size);
    }
  }
  return { spans: [...spans.values()], informative: tokens.filter(isInformative).length };
}

function collectSpans(alternatives) {
  const merged = new Map();
  alternatives.forEach((alternative, index) => {
    // Chrome reports a real confidence on final results and zero on interim ones; fall back to rank alone then.
    const reported = Number(alternative.confidence);
    const trust = Number.isFinite(reported) && reported > 0 ? 0.72 + 0.28 * Math.min(1, reported) : 1;
    const weight = Math.max(0.55, trust * (1 - index * ALTERNATIVE_DECAY));
    const { spans, informative } = spansOf(alternative.transcript);
    for (const span of spans) {
      const previous = merged.get(span.code);
      if (!previous || weight > previous.weight) merged.set(span.code, { ...span, weight, utterance: informative, source: alternative.transcript });
    }
  });
  return [...merged.values()];
}

function excludedKeys(database, excluded, themeId) {
  const keys = new Set();
  for (const value of excluded ?? []) {
    const person = database.findActor(value, themeId) ?? database.findActor(value, "classic");
    if (person) {
      keys.add(person.id);
      keys.add(normalizeText(person.name));
    }
    keys.add(normalizeText(typeof value === "object" ? value?.name : value));
  }
  return keys;
}

export function createVoiceResolver(database) {
  const formsByPerson = new Map();

  function formsFor(person) {
    const signature = `${person.name}|${(person.aliases ?? []).length}`;
    const cached = formsByPerson.get(person.id);
    if (cached?.signature === signature) return cached.forms;
    const forms = personForms(person);
    formsByPerson.set(person.id, { signature, forms });
    return forms;
  }

  function resolve(input, {
    themeId = "classic",
    excluded = [],
    limit = 4,
    previousActor = null,
    linkBonus = LINK_BONUS,
  } = {}) {
    const alternatives = (Array.isArray(input) ? input : [{ transcript: input }])
      .map((alternative) => (typeof alternative === "string" ? { transcript: alternative } : alternative))
      .filter((alternative) => String(alternative?.transcript ?? "").trim());
    if (!alternatives.length) return [];
    const spans = collectSpans(alternatives);
    if (!spans.length) return [];

    const skipped = excludedKeys(database, excluded, themeId);
    const matches = [];
    for (const person of database.people) {
      if (!database.isInTheme(person, themeId)) continue;
      if (skipped.has(person.id) || skipped.has(normalizeText(person.name))) continue;
      let best = null;
      for (const form of formsFor(person)) {
        for (const span of spans) {
          const { score, via, exact } = scoreSpanAgainstForm(span, form);
          if (!score) continue;
          const floor = span.size === 1 ? MIN_SINGLE_SCORE : MIN_MULTI_SCORE;
          if (!exact && (score < floor || (span.size === 1 && span.code.length < 4))) continue;
          const weighted = score * span.weight;
          if (!best || weighted > best.score) best = { score: weighted, via, matchedText: span.raw, transcript: span.source };
        }
      }
      if (best) matches.push({ person, ...best });
    }

    matches.sort((left, right) => right.score - left.score || (right.person.popularity ?? 0) - (left.person.popularity ?? 0));
    const shortlist = matches.slice(0, Math.max(limit * 3, 8));

    // A pair that already shares a film is a slightly likelier reading of the same sounds. The bonus stays
    // small and invisible: revealing it would leak the answer the bluff mechanic is built on.
    if (previousActor && linkBonus > 0) {
      for (const match of shortlist) {
        if (match.score >= 0.999) continue;
        if (database.sharedFilms(previousActor, match.person.name, themeId).length) match.score = Math.min(0.995, match.score + linkBonus);
      }
      shortlist.sort((left, right) => right.score - left.score || (right.person.popularity ?? 0) - (left.person.popularity ?? 0));
    }

    return shortlist.slice(0, limit).map((match) => ({
      ...match.person,
      confidence: Number(match.score.toFixed(4)),
      matchScore: Number(match.score.toFixed(4)),
      matchedText: match.matchedText,
      transcript: match.transcript,
      via: match.via,
      origin: match.person.source === "tmdb" ? "voice-tmdb" : "voice-local",
    }));
  }

  // Phonetising the whole catalogue costs about eighty milliseconds once; doing it before the first
  // sentence keeps the very first recognition as fast as the next ones.
  function warm() {
    for (const person of database.people) formsFor(person);
    return formsByPerson.size;
  }

  return { resolve, formsFor, warm };
}

const resolvers = new WeakMap();

export function resolveVoiceTranscript(transcript, database, options = {}) {
  let resolver = resolvers.get(database);
  if (!resolver) {
    resolver = createVoiceResolver(database);
    resolvers.set(database, resolver);
  }
  return resolver.resolve(transcript, options);
}

// Particles belong to a name but are never capitalised inside it, and never start or end one.
const PARTICLES = new Set(["de", "du", "des", "d", "le", "la", "les", "van", "von", "der", "den", "di", "da", "dos", "del", "della", "el", "al", "ibn", "ben", "bin", "mac", "mc", "o"]);

const capitalisePart = (part) => (part ? part.charAt(0).toLocaleUpperCase("fr") + part.slice(1) : part);

function titleCase(word, index) {
  const key = normalizeText(word);
  if (index > 0 && PARTICLES.has(key)) return word.toLocaleLowerCase("fr");
  // Split on the separators French names carry inside a single word: Jean-Pierre, N'Diaye, O'Neill.
  return word.split(/([-’'])/).map((part, offset) => (offset % 2 ? part : capitalisePart(part))).join("");
}

// A last-resort reading of a sentence when no catalogue entry matches: the players may still vote it in. It is
// built from the raw transcript, so the recogniser's own accents and capitals survive.
export function spokenNameGuess(transcript) {
  const words = String(transcript ?? "")
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}'’-]+$/u, ""))
    .filter(Boolean)
    .map((word) => ({ word, key: normalizeText(word) }))
    .filter((entry) => entry.key);
  // Only the conversational wrapper is stripped, and only from the ends: a particle in the middle is part of
  // the name, while "du" in "du coup" never survives at an edge.
  const droppable = (entry) => FILLER_WORDS.has(entry.key) || entry.key.length < 2 || PARTICLES.has(entry.key);
  let start = 0;
  let end = words.length;
  while (start < end && droppable(words[start])) start += 1;
  while (end > start && droppable(words[end - 1])) end -= 1;
  const kept = words.slice(start, end).slice(0, MAX_SPAN_TOKENS);
  if (!kept.length || kept.every((entry) => STOPWORDS.has(entry.key))) return null;
  if (kept.reduce((total, entry) => total + entry.key.length, 0) < 4) return null;
  return kept.map((entry, index) => titleCase(entry.word, index)).join(" ");
}

export function candidateConfidenceLabel(confidence) {
  if (confidence >= 0.92) return "très probable";
  if (confidence >= 0.78) return "probable";
  if (confidence >= 0.6) return "à confirmer";
  return "incertain";
}
