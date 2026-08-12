export function speechRecognitionConstructor(scope = globalThis) {
  return scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(scope = globalThis) {
  return Boolean(speechRecognitionConstructor(scope));
}

export function createSpeechSession({
  scope = globalThis,
  lang = "fr-FR",
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
  recognition.maxAlternatives = 3;
  let desired = false;
  let listening = false;
  let destroyed = false;

  recognition.onstart = () => {
    listening = true;
    onState({ listening: true, reason: "started" });
  };
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternatives = Array.from(result).map((item) => ({ transcript: item.transcript.trim(), confidence: Number(item.confidence ?? 0) }));
      onTranscript({ transcript: alternatives[0]?.transcript ?? "", alternatives, final: result.isFinal });
    }
  };
  recognition.onerror = (event) => {
    const terminal = ["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error);
    if (terminal) desired = false;
    onError({ code: event.error, message: event.message ?? event.error, terminal });
  };
  recognition.onend = () => {
    listening = false;
    onState({ listening: false, reason: "ended" });
    if (desired && !destroyed) {
      scope.setTimeout(() => {
        if (!desired || destroyed) return;
        try { recognition.start(); } catch { /* The browser may still be closing the previous session. */ }
      }, 180);
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
        onError({ code: "start-failed", message: error.message, terminal: false });
        return false;
      }
    },
    stop() {
      desired = false;
      if (listening) recognition.stop();
    },
    destroy() {
      desired = false;
      destroyed = true;
      try { recognition.abort(); } catch { /* Already inactive. */ }
    },
    isListening: () => listening,
  };
}
