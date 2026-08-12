import { normalizeText } from "../game/identity.js";

const FILLER_WORDS = new Set(["acteur", "actrice", "alors", "avec", "cinema", "dans", "dis", "dirais", "film", "je", "joue", "pense", "propose", "suivant", "une"]);

function deduplicate(candidates, limit) {
  const bestById = new Map();
  for (const candidate of candidates) {
    const key = candidate.id ?? normalizeText(candidate.name);
    const previous = bestById.get(key);
    if (!previous || candidate.confidence > previous.confidence) bestById.set(key, candidate);
  }
  return [...bestById.values()]
    .sort((left, right) => right.confidence - left.confidence || Number(right.popularity ?? 0) - Number(left.popularity ?? 0))
    .slice(0, limit);
}

export function resolveVoiceTranscript(transcript, database, { themeId = "classic", excluded = [], limit = 4 } = {}) {
  const raw = String(transcript ?? "").trim();
  if (!raw) return [];
  const exact = database.matchMentions(raw, { themeId, excluded, limit });
  const candidates = exact.map((person) => ({ ...person, confidence: Number(person.matchScore ?? 0.9), transcript: raw }));
  const tokens = normalizeText(raw).split(" ").filter((token) => token && !FILLER_WORDS.has(token));
  for (let size = Math.min(4, tokens.length); size >= 1; size -= 1) {
    for (let start = 0; start <= tokens.length - size; start += 1) {
      const phrase = tokens.slice(start, start + size).join(" ");
      if (phrase.length < 3) continue;
      for (const person of database.searchPeople(phrase, { themeId, excluded, limit })) {
        const completeness = Math.min(1, normalizeText(person.name).split(" ").length / Math.max(1, size));
        candidates.push({ ...person, confidence: Math.min(0.89, Number(person.matchScore ?? 0.7) * (0.78 + completeness * 0.18)), transcript: raw });
      }
    }
  }
  return deduplicate(candidates, limit);
}

export function candidateConfidenceLabel(confidence) {
  if (confidence >= 0.92) return "très probable";
  if (confidence >= 0.78) return "probable";
  if (confidence >= 0.6) return "à confirmer";
  return "incertain";
}
