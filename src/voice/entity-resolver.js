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
const SURNAME_FACTOR = 0.94;
const ALTERNATIVE_DECAY = 0.035;
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
    forms.push({ kind, text: value, normalized: normalizeText(value), code, tails: inverted ? [] : tailForms(tokens) });
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
  if (span.normalized === form.normalized) return { score: 1, via: form.kind, exact: true };
  let score = compareCodes(span.code, form.code);
  let via = form.kind;
  for (const tail of form.tails) {
    const tailScore = compareCodes(span.code, tail) * SURNAME_FACTOR;
    if (tailScore > score) {
      score = tailScore;
      via = "surname";
    }
  }
  return { score, via, exact: false };
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
  });
}

function spansOf(transcript) {
  const words = phoneticNormalize(transcript).split(" ").filter(Boolean);
  if (!words.length) return [];
  const tokens = words.map((word) => ({ raw: word, normalized: word, code: phoneticCode(word) })).filter((token) => token.code);
  const condensed = tokens.filter((token) => !FILLER_WORDS.has(token.normalized));
  const spans = new Map();
  for (const list of condensed.length && condensed.length !== tokens.length ? [tokens, condensed] : [tokens]) {
    for (let size = 1; size <= Math.min(MAX_SPAN_TOKENS, list.length); size += 1) {
      for (let start = 0; start + size <= list.length; start += 1) pushSpan(spans, list, start, start + size);
    }
  }
  return [...spans.values()];
}

function collectSpans(alternatives) {
  const merged = new Map();
  alternatives.forEach((alternative, index) => {
    const weight = Math.max(0.8, 1 - index * ALTERNATIVE_DECAY);
    for (const span of spansOf(alternative.transcript)) {
      const previous = merged.get(span.code);
      if (!previous || weight > previous.weight) merged.set(span.code, { ...span, weight, source: alternative.transcript });
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

// A last-resort reading of a sentence when no catalogue entry matches: the players may still vote it in.
export function spokenNameGuess(transcript) {
  const words = phoneticNormalize(transcript).split(" ").filter((word) => word && !FILLER_WORDS.has(word));
  const meaningful = words.filter((word) => !STOPWORDS.has(word) || words.length <= 3);
  const kept = (meaningful.length ? meaningful : words).slice(0, MAX_SPAN_TOKENS);
  if (!kept.length || kept.join("").length < 4) return null;
  return kept.map((word) => word.charAt(0).toLocaleUpperCase("fr") + word.slice(1)).join(" ");
}

export function candidateConfidenceLabel(confidence) {
  if (confidence >= 0.92) return "très probable";
  if (confidence >= 0.78) return "probable";
  if (confidence >= 0.6) return "à confirmer";
  return "incertain";
}
