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
  // Les identifiants qu'une phrase plus complète a fait disparaître : ils ne peuvent plus revenir.
  let supersededIds = new Set();

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
    return pool;
  }

  return {
    ingest({ id, transcript = "", final = false, candidates = [], at = 0 } = {}) {
      // Un énoncé déjà remplacé par sa version complète ne revient pas. L'écran ré-injecte volontairement le MÊME
      // identifiant après son aller-retour réseau : si la phrase complète est arrivée entre-temps, le fragment
      // périmé se réinstallait avec ses candidats, et `lastTranscript()` régressait jusqu'à lui — la carte
      // « hors catalogue » proposait alors au vote le fragment plutôt que le nom complet.
      if (id !== undefined && supersededIds.has(id)) return pool;
      const utterance = { id: id ?? `utterance-${utterances.length}`, transcript, final, candidates, at };
      if (transcript.trim()) {
        heard = [...heard.filter((entry) => entry.id !== utterance.id), { id: utterance.id, transcript: transcript.trim(), final, at }].slice(-maxHeard);
      }
      // Recognition arrives in growing pieces: "Camille" then "Camille Chamoux". The shorter one is not a second
      // opinion, it is the same sentence half-heard, and whatever it matched must go with it — even, and above
      // all, when the completed sentence matches nothing at all.
      const spoken = normalizeText(transcript);
      const kept = spoken
        ? utterances.filter((entry) => {
          if (entry.id === utterance.id) return true;
          const previous = normalizeText(entry.transcript);
          // Seuls les préfixes STRICTS cèdent la place. Un énoncé identique n'est pas une phrase à moitié entendue
          // mais une répétition — le joueur redit le nom parce que rien ne se passe — et doit compter comme une
          // seconde mention, ce que le bonus de répétition attend précisément.
          return previous === spoken || !`${spoken} `.startsWith(`${previous} `);
        })
        : utterances;
      const superseded = kept.length !== utterances.length;
      if (superseded) {
        const survivors = new Set(kept.map((entry) => entry.id));
        for (const entry of utterances) if (!survivors.has(entry.id)) supersededIds.add(entry.id);
      }
      utterances = kept;
      const index = utterances.findIndex((entry) => entry.id === utterance.id);
      if (index >= 0) {
        // A final result supersedes the interim guesses it was built from.
        if (!candidates.length && !utterances[index].candidates.length) return superseded ? recompute() : pool;
        utterances[index] = utterance;
      } else {
        if (!candidates.length) return superseded ? recompute() : pool;
        utterances = [...utterances, utterance].slice(-maxUtterances);
      }
      return recompute();
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
      supersededIds = new Set();
      return pool;
    },
    reset() {
      utterances = [];
      heard = [];
      pool = [];
      supersededIds = new Set();
      return pool;
    },
  };
}
