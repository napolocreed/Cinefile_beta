export const DIAGNOSTICS_KEY = "cinefil.diagnostics.v1";
const MAX_ENTRIES = 30;

function safeParse(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

export function createDiagnostics(storage = globalThis.localStorage, location = globalThis.location) {
  function settings() {
    return safeParse(storage?.getItem("cinefil.settings.v1"), {});
  }
  function isEnabled() {
    return settings().localDiagnostics === true;
  }
  function setEnabled(enabled) {
    storage?.setItem("cinefil.settings.v1", JSON.stringify({ ...settings(), localDiagnostics: Boolean(enabled) }));
    if (!enabled) clear();
  }
  function load() {
    return safeParse(storage?.getItem(DIAGNOSTICS_KEY), []);
  }
  function capture(error, context = {}) {
    if (!isEnabled()) return false;
    const entry = {
      at: new Date().toISOString(),
      name: String(error?.name ?? "Error").slice(0, 80),
      message: String(error?.message ?? error ?? "Erreur inconnue").slice(0, 500),
      path: String(context.path ?? location?.pathname ?? "").slice(0, 200),
      phase: String(context.phase ?? "runtime").slice(0, 80),
    };
    storage?.setItem(DIAGNOSTICS_KEY, JSON.stringify([entry, ...load()].slice(0, MAX_ENTRIES)));
    return true;
  }
  function clear() {
    storage?.removeItem(DIAGNOSTICS_KEY);
  }
  function install(scope = globalThis) {
    const onError = (event) => capture(event.error ?? event.message, { phase: "window-error" });
    const onRejection = (event) => capture(event.reason, { phase: "unhandled-rejection" });
    scope?.addEventListener?.("error", onError);
    scope?.addEventListener?.("unhandledrejection", onRejection);
    return () => {
      scope?.removeEventListener?.("error", onError);
      scope?.removeEventListener?.("unhandledrejection", onRejection);
    };
  }
  return { capture, clear, install, isEnabled, load, setEnabled };
}
