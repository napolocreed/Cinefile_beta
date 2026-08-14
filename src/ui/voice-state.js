// The shape of the voice mode's session state, kept in its own leaf module: both the runtime (which seeds the
// initial state) and the voice screen (which resets it) need it, and neither may import the other.

import { createTurnBuffer } from "../voice/turn-buffer.js";
import { isSpeechRecognitionSupported } from "../voice/speech-session.js";

export function createVoiceTurn(playerId = null) {
  return { playerId, buffer: createTurnBuffer(), remoteLookups: 0, remoteResults: new Map(), startedAt: Date.now() };
}

export function createVoiceState() {
  return {
    supported: isSpeechRecognitionSupported(window),
    session: null,
    consent: false,
    listening: false,
    processing: false,
    interim: "",
    error: null,
    entries: [],
    turn: createVoiceTurn(),
    review: null,
    verdict: null,
    utterances: 0,
    manualOpen: false,
    flash: null,
    flashTimer: null,
    flashToken: 0,
    outcome: null,
  };
}
