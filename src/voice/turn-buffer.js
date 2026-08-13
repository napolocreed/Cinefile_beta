import { normalizeText } from "../game/identity.js";

// Everything said during one turn feeds a single pool of propositions. A sentence that contains no
// recognisable name adds nothing and — crucially — removes nothing: a stray word can no longer wipe the
// name a player already pronounced.
export function createTurnBuffer({
  limit = 4,
  maxUtterances = 8,
  maxHeard = 4,
  repeatBonus = 0.02,
  maxRepeatBonus = 0.06,
  interimWeight = 0.96,
} = {}) {
  let utterances = [];
  let heard = [];
  let pool = [];

  function candidateKey(candidate) {
    return candidate.id ?? `spoken:${normalizeText(candidate.name)}`;
  }

  function recompute() {
    const aggregated = new Map();
    for (const utterance of utterances) {
      const weight = utterance.final ? 1 : interimWeight;
      for (const candidate of utterance.candidates) {
        const key = candidateKey(candidate);
        const score = Number(candidate.confidence ?? 0) * weight;
        const previous = aggregated.get(key);
        if (!previous) {
          aggregated.set(key, { candidate, score, mentions: 1, lastAt: utterance.at ?? 0 });
          continue;
        }
        previous.mentions += 1;
        previous.lastAt = Math.max(previous.lastAt, utterance.at ?? 0);
        if (score > previous.score) {
          previous.score = score;
          previous.candidate = candidate;
        }
      }
    }
    pool = [...aggregated.values()]
      .map((entry) => ({
        ...entry.candidate,
        confidence: Math.min(0.999, entry.score + Math.min(maxRepeatBonus, (entry.mentions - 1) * repeatBonus)),
        mentions: entry.mentions,
        lastAt: entry.lastAt,
      }))
      .sort((left, right) => right.confidence - left.confidence || right.lastAt - left.lastAt || (right.popularity ?? 0) - (left.popularity ?? 0))
      .slice(0, limit);
  }

  return {
    ingest({ id, transcript = "", final = false, candidates = [], at = 0 } = {}) {
      const utterance = { id: id ?? `utterance-${utterances.length}`, transcript, final, candidates, at };
      if (transcript.trim()) {
        heard = [...heard.filter((entry) => entry.id !== utterance.id), { id: utterance.id, transcript: transcript.trim(), final, at }].slice(-maxHeard);
      }
      const index = utterances.findIndex((entry) => entry.id === utterance.id);
      if (index >= 0) {
        // A final result supersedes the interim guesses it was built from.
        if (!candidates.length && !utterances[index].candidates.length) return pool;
        utterances[index] = utterance;
      } else {
        if (!candidates.length) return pool;
        utterances = [...utterances, utterance].slice(-maxUtterances);
      }
      recompute();
      return pool;
    },
    candidates: () => pool,
    heard: () => heard,
    lastTranscript: () => heard.at(-1)?.transcript ?? "",
    isEmpty: () => pool.length === 0,
    drop(candidate) {
      const key = candidateKey(candidate);
      utterances = utterances.map((utterance) => ({ ...utterance, candidates: utterance.candidates.filter((entry) => candidateKey(entry) !== key) }));
      recompute();
      return pool;
    },
    // Dropping the propositions must not drop what was heard: the raw sentence is the last way back in when the
    // catalogue keeps proposing the wrong artist.
    clearCandidates() {
      utterances = [];
      pool = [];
      return pool;
    },
    reset() {
      utterances = [];
      heard = [];
      pool = [];
      return pool;
    },
  };
}
