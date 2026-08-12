import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/game/database.js";
import { candidateConfidenceLabel, resolveVoiceTranscript } from "../src/voice/entity-resolver.js";
import { createSpeechSession, isSpeechRecognitionSupported } from "../src/voice/speech-session.js";

const database = createDatabase({
  actors: [
    { name: "Leonardo DiCaprio", aliases: ["Leo DiCaprio"], films: ["Titanic"], tags: [] },
    { name: "Kate Winslet", films: ["Titanic"], tags: [] },
    { name: "Dwayne Johnson", aliases: ["The Rock"], films: ["Jumanji"], tags: [] },
  ],
  films: ["Titanic", "Jumanji"],
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
  const alternative = { 0: { transcript: " Kate Winslet ", confidence: 0.91 }, length: 1, isFinal: true };
  instance.onresult({ resultIndex: 0, results: [alternative] });
  assert.equal(transcripts[0].transcript, "Kate Winslet");
  assert.equal(transcripts[0].final, true);
  session.stop();
  assert.equal(session.isListening(), false);
});
