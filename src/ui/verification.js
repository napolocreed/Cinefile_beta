// The VAR report. A verdict is only worth as much as the trail behind it, so the cascade is rendered in full:
// who was asked, in which order, what came back, and how long it took.

import { escapeHtml } from "./format.js";

const TRUSTED_EXTERNAL_HOSTS = [
  "google.com",
  "www.google.com",
  "duckduckgo.com",
  "www.qwant.com",
  "fr.wikipedia.org",
  "en.wikipedia.org",
  "www.wikidata.org",
  "www.themoviedb.org",
];

export function safeExternalHref(value) {
  try {
    const url = new URL(value);
    const trusted = TRUSTED_EXTERNAL_HOSTS.includes(url.hostname) || url.hostname.endsWith(".wikipedia.org");
    return url.protocol === "https:" && trusted ? escapeHtml(url.href) : null;
  } catch {
    return null;
  }
}

export function verificationSourceLabel(source) {
  return ({
    local: "base Ciné-Fil",
    tmdb: "TMDb",
    wikidata: "Wikidata",
    wikipedia: "Wikipédia",
    none: "sources externes",
  })[source] ?? source ?? "sources externes";
}

const VERIFICATION_OUTCOMES = Object.freeze({
  confirmed: { label: "preuve trouvée", tone: "found" },
  probable: { label: "indice trouvé", tone: "hint" },
  empty: { label: "rien trouvé", tone: "empty" },
  skipped: { label: "non configurée", tone: "idle" },
  error: { label: "injoignable", tone: "error" },
  "not-reached": { label: "inutile", tone: "idle" },
  abandoned: { label: "abandonnée", tone: "idle" },
});

export function verificationCascadeMarkup(verification) {
  const steps = Array.isArray(verification?.steps) ? verification.steps : [];
  if (!steps.length) return "";
  const stopIndex = steps.findIndex((step) => step.outcome === "confirmed" || step.outcome === "probable");
  const rows = steps.map((step, index) => {
    const outcome = VERIFICATION_OUTCOMES[step.outcome] ?? VERIFICATION_OUTCOMES.empty;
    const found = index === stopIndex;
    const duration = Number(step.durationMs) > 0
      ? `${(Number(step.durationMs) / 1000).toFixed(Number(step.durationMs) >= 1000 ? 1 : 2)} s`
      : "—";
    const films = found && Number(step.films) > 0 ? `${step.films} œuvre${step.films > 1 ? "s" : ""}` : outcome.label;
    return `<li class="var-step var-step--${outcome.tone} ${found ? "var-step--found" : ""}"><span class="var-step__rank">${String(index + 1).padStart(2, "0")}</span><span class="var-step__source">${escapeHtml(verificationSourceLabel(step.source))}</span><span class="var-step__outcome">${escapeHtml(films)}</span><span class="var-step__time">${escapeHtml(duration)}</span></li>`;
  }).join("");
  const total = Number(verification?.durationMs);
  const footer = stopIndex >= 0
    ? `Preuve retenue à l’étape ${String(stopIndex + 1).padStart(2, "0")} · ${escapeHtml(verificationSourceLabel(steps[stopIndex].source))}`
    : "Aucune source n’a produit de preuve";
  return `<div class="var-cascade"><small>Cascade de vérification</small><ol class="var-steps">${rows}</ol><p class="var-cascade__foot">${footer}${Number.isFinite(total) && total > 0 ? ` · ${(total / 1000).toFixed(1)} s au total` : ""}${verification?.cached ? " · réponse déjà connue" : ""}</p></div>`;
}

export function verificationPanelMarkup(verification) {
  const candidateVerdict = verification?.verdict ?? "UNKNOWN";
  const verdict = ["CONFIRMED", "PROBABLE", "NOT_FOUND", "UNKNOWN"].includes(candidateVerdict) ? candidateVerdict : "UNKNOWN";
  const steps = Array.isArray(verification?.steps) ? verification.steps : [];
  const contacted = steps.some((step) => step.source !== "local" && !["skipped", "not-reached"].includes(step.outcome));
  const unknownCopy = contacted
    ? ["Vérification indisponible", "Le réseau ou une source externe n’a pas répondu. Le jugement humain reste prioritaire."]
    : ["Aucune source consultée", "Cette édition du jeu ne joint aucun service externe : seule la base embarquée a cherché, sans résultat. La décision revient à la table, et les recherches ci-dessous s’ouvrent d’un geste."];
  const copy = {
    PROBABLE: ["Indice trouvé", "Une page de film mentionne les deux artistes, mais la distribution structurée ne suffit pas à confirmer le lien. Vérifiez la preuve avant de trancher."],
    NOT_FOUND: ["Aucun lien retrouvé", "La cascade a cherché sans résultat. Cela renforce le soupçon de bluff, mais une absence de résultat ne prouve jamais qu’un film n’existe pas."],
    UNKNOWN: unknownCopy,
  }[verdict] ?? ["Lien confirmé", `Une œuvre commune a été retrouvée via ${verificationSourceLabel(verification?.source)}.`];
  const evidence = (verification?.evidence ?? []).slice(0, 6).map((entry) => {
    const href = safeExternalHref(entry.url);
    const title = `${escapeHtml(entry.title ?? "Preuve")}${entry.year ? ` <small>(${escapeHtml(entry.year)})</small>` : ""}`;
    return `<li>${href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<span>${title}</span>`}${entry.snippet ? `<p>${escapeHtml(entry.snippet)}</p>` : ""}</li>`;
  }).join("");
  const labels = { google: "Google", duckduckgo: "DuckDuckGo", qwant: "Qwant", wikipedia: "Wikipédia" };
  const links = Object.entries(verification?.searchLinks ?? {}).map(([key, value]) => {
    const href = safeExternalHref(value);
    return href ? `<a class="var-link" href="${href}" target="_blank" rel="noopener noreferrer">${labels[key] ?? escapeHtml(key)}</a>` : "";
  }).join("");
  return `<section class="var-panel var-panel--${verdict.toLowerCase()}"><span class="var-panel__status">${escapeHtml(copy[0])}</span><p>${escapeHtml(copy[1])}</p>${verificationCascadeMarkup(verification)}${evidence ? `<div class="var-evidence"><small>Indices récoltés</small><ul>${evidence}</ul></div>` : ""}<div class="var-links" aria-label="Recherches manuelles">${links}</div></section>`;
}
