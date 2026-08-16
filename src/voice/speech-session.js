export function speechRecognitionConstructor(scope = globalThis) {
  return scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(scope = globalThis) {
  return Boolean(speechRecognitionConstructor(scope));
}

// Silence and self-restarts are the normal life of a continuous recogniser, not failures to report.
const TRANSIENT_ERRORS = new Set(["no-speech", "aborted", "network"]);
const TERMINAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

export function createSpeechSession({
  scope = globalThis,
  lang = "fr-FR",
  maxAlternatives = 5,
  restartDelay = 180,
  onTranscript = () => {},
  onState = () => {},
  onError = () => {},
} = {}) {
  const Recognition = speechRecognitionConstructor(scope);
  if (!Recognition) {
    return {
      supported: false,
      start: () => false,
      stop: () => {},
      destroy: () => {},
      isListening: () => false,
    };
  }

  const recognition = new Recognition();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = maxAlternatives;
  let desired = false;
  let listening = false;
  let destroyed = false;
  // Result indexes restart from zero on every recogniser restart; the epoch keeps utterance ids unique.
  let epoch = 0;

  recognition.onstart = () => {
    // `onstart` est asynchrone dans les navigateurs. Un « Pause micro » appuyé pendant cette fenêtre a déjà remis
    // `desired` à false sans que stop() ait rien pu couper, faute de `listening`. Sans cette relecture, la session
    // repartait à l'écoute pour toujours — micro réellement ouvert — pendant que l'interface affichait « Micro en
    // pause » et que rien, en aval, ne revérifiait le consentement.
    if (!desired || destroyed) {
      try { recognition.stop(); } catch { /* Already closing. */ }
      return;
    }
    listening = true;
    onState({ listening: true, reason: "started" });
  };
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternatives = Array.from(result)
        .map((item) => ({ transcript: String(item.transcript ?? "").trim(), confidence: Number(item.confidence ?? 0) }))
        .filter((alternative) => alternative.transcript);
      onTranscript({
        id: `${epoch}:${index}`,
        transcript: alternatives[0]?.transcript ?? "",
        alternatives,
        final: Boolean(result.isFinal),
      });
    }
  };
  recognition.onerror = (event) => {
    const terminal = TERMINAL_ERRORS.has(event.error);
    if (terminal) desired = false;
    onError({ code: event.error, message: event.message ?? event.error, terminal, transient: TRANSIENT_ERRORS.has(event.error) });
  };
  recognition.onend = () => {
    listening = false;
    epoch += 1;
    onState({ listening: false, reason: "ended" });
    if (desired && !destroyed) {
      scope.setTimeout(() => {
        if (!desired || destroyed) return;
        try { recognition.start(); } catch { /* The browser may still be closing the previous session. */ }
      }, restartDelay);
    }
  };

  return {
    supported: true,
    start() {
      desired = true;
      if (listening) return true;
      try {
        recognition.start();
        return true;
      } catch (error) {
        onError({ code: "start-failed", message: error.message, terminal: false, transient: true });
        return false;
      }
    },
    stop() {
      desired = false;
      // Inconditionnel : `listening` est encore faux entre start() et onstart, et c'est précisément la fenêtre où
      // l'appui se perdait. `desired` est la seule autorité, ce drapeau ne fait que refléter l'état publié.
      try { recognition.stop(); } catch { /* Pas encore démarré, ou déjà en train de se fermer. */ }
    },
    destroy() {
      desired = false;
      destroyed = true;
      try { recognition.abort(); } catch { /* Already inactive. */ }
    },
    isListening: () => listening,
  };
}
