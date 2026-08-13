import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/game/database.js";
import { candidateConfidenceLabel, createVoiceResolver, resolveVoiceTranscript, spokenNameGuess } from "../src/voice/entity-resolver.js";
import { phoneticCode, phoneticSimilarity } from "../src/voice/phonetics.js";
import { createTurnBuffer } from "../src/voice/turn-buffer.js";
import { createSpeechSession, isSpeechRecognitionSupported } from "../src/voice/speech-session.js";

const database = createDatabase({
  actors: [
    { name: "Leonardo DiCaprio", aliases: ["Leo DiCaprio"], films: ["Titanic"], tags: [] },
    { name: "Kate Winslet", films: ["Titanic"], tags: [] },
    { name: "Dwayne Johnson", aliases: ["The Rock"], films: ["Jumanji"], tags: [] },
  ],
  films: ["Titanic", "Jumanji"],
});

const french = createDatabase({
  actors: [
    { name: "Jean Dujardin", films: ["OSS 117", "The Artist"], tags: ["fr"] },
    { name: "Gérard Depardieu", films: ["Les Valseuses"], tags: ["fr"] },
    { name: "Julie Depardieu", films: ["Un secret"], tags: ["fr"] },
    { name: "Patrick Dewaere", films: ["Les Valseuses"], tags: ["fr"] },
    { name: "Omar Sy", films: ["Intouchables"], tags: ["fr"] },
    { name: "Louis de Funès", films: ["Le Corniaud"], tags: ["fr"] },
    { name: "Bérénice Bejo", films: ["The Artist", "OSS 117"], tags: ["fr"] },
    { name: "Marion Cotillard", films: ["La Môme"], tags: ["fr"] },
    { name: "Jean Reno", films: ["Léon"], tags: ["fr"] },
  ],
  films: ["OSS 117", "The Artist", "Les Valseuses", "Un secret", "Intouchables", "Le Corniaud", "La Môme", "Léon"],
});

test("voice resolution extracts an artist from a natural French sentence", () => {
  const candidates = resolveVoiceTranscript("Alors moi je propose Leonardo Di Caprio", database);
  assert.equal(candidates[0].name, "Leonardo DiCaprio");
  assert.equal(candidates[0].confidence >= 0.78, true);
});

test("voice resolution uses aliases and respects excluded chain members", () => {
  assert.equal(resolveVoiceTranscript("je dis The Rock", database)[0].name, "Dwayne Johnson");
  assert.equal(resolveVoiceTranscript("je dis Kate Winslet", database, { excluded: ["Kate Winslet"] }).some((candidate) => candidate.name === "Kate Winslet"), false);
  assert.equal(candidateConfidenceLabel(0.93), "très probable");
});

test("French phonetics fold the spellings speech recognition invents", () => {
  assert.equal(phoneticCode("du jardin"), phoneticCode("Dujardin"));
  assert.equal(phoneticCode("de Pardieu"), phoneticCode("Depardieu"));
  assert.equal(phoneticCode("Poel Voorde"), phoneticCode("Poelvoorde"));
  assert.equal(phoneticCode("Sy") !== phoneticCode("six"), true);
  assert.equal(phoneticSimilarity(phoneticCode("Omar six"), phoneticCode("Omar Sy")) > 0.8, true);
  assert.equal(phoneticSimilarity(phoneticCode("Dujardin"), phoneticCode("Depardieu")) < 0.6, true);
});

test("voice resolution recognises French artists through recognition spelling drift", () => {
  const resolver = createVoiceResolver(french);
  const cases = [
    ["alors moi je dis jean du jardin", "Jean Dujardin"],
    ["gérard de pardieu", "Gérard Depardieu"],
    ["je propose omar six", "Omar Sy"],
    ["louis de funes", "Louis de Funès"],
    ["marion cotillar", "Marion Cotillard"],
    ["jean renaud", "Jean Reno"],
  ];
  for (const [spoken, expected] of cases) {
    const [best] = resolver.resolve(spoken, { themeId: "fr" });
    assert.equal(best?.name, expected, `« ${spoken} » aurait dû donner ${expected}`);
  }
});

test("a surname alone is enough, a common word never is", () => {
  const resolver = createVoiceResolver(french);
  assert.equal(resolver.resolve("depardieu", { themeId: "fr" }).length > 0, true);
  for (const noise of ["euh attends je réfléchis", "ah oui c’est bon", "je sais pas moi", "bon alors vas-y"]) {
    assert.deepEqual(resolver.resolve(noise, { themeId: "fr" }), [], `« ${noise} » ne doit rien proposer`);
  }
});

test("voice resolution reads every recognition alternative", () => {
  const resolver = createVoiceResolver(french);
  const candidates = resolver.resolve([
    { transcript: "berry nice bejo", confidence: 0.4 },
    { transcript: "bérénice béjo", confidence: 0.3 },
  ], { themeId: "fr" });
  assert.equal(candidates[0].name, "Bérénice Bejo");
});

test("a shared filmography breaks ties without being announced", () => {
  const resolver = createVoiceResolver(french);
  const neutral = resolver.resolve("depardieu", { themeId: "fr" });
  const biased = resolver.resolve("depardieu", { themeId: "fr", previousActor: "Patrick Dewaere", excluded: ["Patrick Dewaere"] });
  assert.equal(neutral.length >= 2, true);
  assert.equal(biased[0].name, "Gérard Depardieu");
  assert.equal(Object.hasOwn(biased[0], "sharedFilms"), false);
});

test("the turn buffer accumulates propositions and survives a meaningless sentence", () => {
  const buffer = createTurnBuffer();
  buffer.ingest({ id: "1", transcript: "jean dujardin", final: true, candidates: [{ id: "p1", name: "Jean Dujardin", confidence: 0.95 }], at: 1 });
  buffer.ingest({ id: "2", transcript: "euh attends", final: true, candidates: [], at: 2 });
  assert.deepEqual(buffer.candidates().map((candidate) => candidate.name), ["Jean Dujardin"]);
  assert.equal(buffer.lastTranscript(), "euh attends");

  buffer.ingest({ id: "3", transcript: "ou alors omar sy", final: true, candidates: [{ id: "p2", name: "Omar Sy", confidence: 0.9 }], at: 3 });
  assert.deepEqual(buffer.candidates().map((candidate) => candidate.name), ["Jean Dujardin", "Omar Sy"]);

  buffer.reset();
  assert.deepEqual(buffer.candidates(), []);
});

test("a final result supersedes the interim guesses it grew from", () => {
  const buffer = createTurnBuffer();
  buffer.ingest({ id: "0:0", transcript: "jean du", final: false, candidates: [{ id: "p9", name: "Jean Dujardin", confidence: 0.72 }], at: 1 });
  buffer.ingest({ id: "0:0", transcript: "jean dujardin", final: true, candidates: [{ id: "p1", name: "Jean Dujardin", confidence: 0.95 }], at: 2 });
  const [best] = buffer.candidates();
  assert.equal(best.id, "p1");
  assert.equal(best.mentions, 1);
  assert.equal(best.confidence >= 0.95, true);
});

test("repeating a name lifts it above a one-off mishearing", () => {
  const buffer = createTurnBuffer();
  buffer.ingest({ id: "1", transcript: "jean reno", final: true, candidates: [{ id: "reno", name: "Jean Reno", confidence: 0.86 }, { id: "renaud", name: "Line Renaud", confidence: 0.88 }], at: 1 });
  buffer.ingest({ id: "2", transcript: "jean reno", final: true, candidates: [{ id: "reno", name: "Jean Reno", confidence: 0.86 }], at: 2 });
  assert.equal(buffer.candidates()[0].name, "Jean Reno");
});

test("an off-catalogue sentence still yields a name the table can vote on", () => {
  assert.equal(spokenNameGuess("alors moi je dis Machin Bidule"), "Machin Bidule");
  assert.equal(spokenNameGuess("euh"), null);
});

test("speech sessions expose an explicit unsupported fallback", () => {
  assert.equal(isSpeechRecognitionSupported({}), false);
  const session = createSpeechSession({ scope: {} });
  assert.equal(session.supported, false);
  assert.equal(session.start(), false);
});

test("speech sessions emit transcripts and stop automatic listening on demand", () => {
  let instance;
  class Recognition {
    constructor() { instance = this; }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() { this.onend?.(); }
  }
  const transcripts = [];
  const scope = { SpeechRecognition: Recognition, setTimeout: (callback) => callback() };
  const session = createSpeechSession({ scope, onTranscript: (event) => transcripts.push(event) });
  assert.equal(session.start(), true);
  assert.equal(session.isListening(), true);
  const alternative = { 0: { transcript: " Kate Winslet ", confidence: 0.91 }, 1: { transcript: "Kate Winslett", confidence: 0.4 }, length: 2, isFinal: true };
  instance.onresult({ resultIndex: 0, results: [alternative] });
  assert.equal(transcripts[0].transcript, "Kate Winslet");
  assert.equal(transcripts[0].final, true);
  assert.equal(transcripts[0].id, "0:0");
  assert.deepEqual(transcripts[0].alternatives.map((entry) => entry.transcript), ["Kate Winslet", "Kate Winslett"]);
  session.stop();
  assert.equal(session.isListening(), false);
});

test("silence and restarts are reported as transient, refused permissions are not", () => {
  let instance;
  class Recognition {
    constructor() { instance = this; }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() {}
  }
  const errors = [];
  const session = createSpeechSession({ scope: { SpeechRecognition: Recognition, setTimeout: () => {} }, onError: (event) => errors.push(event) });
  session.start();
  instance.onerror({ error: "no-speech" });
  instance.onerror({ error: "not-allowed" });
  assert.equal(errors[0].transient, true);
  assert.equal(errors[0].terminal, false);
  assert.equal(errors[1].transient, false);
  assert.equal(errors[1].terminal, true);
});

test("utterance ids stay unique across recogniser restarts", () => {
  let instance;
  class Recognition {
    constructor() { instance = this; }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() {}
  }
  const transcripts = [];
  const session = createSpeechSession({ scope: { SpeechRecognition: Recognition, setTimeout: (callback) => callback() }, onTranscript: (event) => transcripts.push(event) });
  session.start();
  const result = { 0: { transcript: "Omar Sy", confidence: 0.8 }, length: 1, isFinal: true };
  instance.onresult({ resultIndex: 0, results: [result] });
  instance.onend();
  instance.onresult({ resultIndex: 0, results: [result] });
  assert.notEqual(transcripts[0].id, transcripts[1].id);
  session.destroy();
});

test("a nickname is a weaker reading than a name", () => {
  const nicknamed = createDatabase({
    actors: [
      { name: "Prince", aliases: ["Camille", "The Artist Formerly Known As Prince"], films: ["Purple Rain"], tags: [] },
      { name: "Dwayne Johnson", aliases: ["The Rock"], films: ["Jumanji"], tags: [] },
    ],
    films: ["Purple Rain", "Jumanji"],
  });
  const resolver = createVoiceResolver(nicknamed);
  // TMDb hands out hundreds of one-word aliases; hearing one must stay short of certainty so the off-catalogue
  // card, which hides above 0.93, keeps its place.
  const [nickname] = resolver.resolve("camille");
  assert.equal(nickname.name, "Prince");
  assert.equal(nickname.confidence < 0.85, true, `un surnom ne doit pas être certain (${nickname.confidence})`);
  assert.equal(resolver.resolve("prince")[0].confidence > 0.9, true);
  assert.equal(resolver.resolve("the rock")[0].confidence > 0.9, true);
  assert.deepEqual(resolver.resolve("camille chamoux"), []);
});

test("a completed sentence retires the fragment it grew from", () => {
  const buffer = createTurnBuffer();
  buffer.ingest({ id: "0:0", transcript: "Camille", final: true, candidates: [{ id: "prince", name: "Prince", confidence: 0.76 }], at: 1 });
  assert.deepEqual(buffer.candidates().map((candidate) => candidate.name), ["Prince"]);
  // The player was mid-name. Completing it must take the half-heard reading away, even though the finished
  // sentence matches nothing at all — that is what leaves the off-catalogue card alone on screen.
  buffer.ingest({ id: "0:1", transcript: "Camille Chamoux", final: true, candidates: [], at: 2 });
  assert.deepEqual(buffer.candidates(), []);
  assert.equal(buffer.lastTranscript(), "Camille Chamoux");

  // An unrelated sentence still removes nothing.
  const other = createTurnBuffer();
  other.ingest({ id: "1:0", transcript: "Jean Dujardin", final: true, candidates: [{ id: "jd", name: "Jean Dujardin", confidence: 0.97 }], at: 1 });
  other.ingest({ id: "1:1", transcript: "euh attends", final: true, candidates: [], at: 2 });
  assert.deepEqual(other.candidates().map((candidate) => candidate.name), ["Jean Dujardin"]);
});
