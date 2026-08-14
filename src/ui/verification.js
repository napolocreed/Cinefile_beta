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

// Le carton du verdict « rien trouvé ».
//
// La règle du jeu tenait en deux lignes de prose que personne ne lisait deux fois. Une réplique la dit mieux, et
// une table la retient. Le sceau est une silhouette originale, dessinée dans la direction artistique du jeu — on
// n'y reproduit aucun personnage protégé — et il est purement décoratif : tout ce qui compte est dans le texte.
const NOT_FOUND_QUOTE = `<figure class="var-quote"><svg class="var-quote__seal" viewBox="0 0 64 64" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="varseal-disc"><circle cx="32" cy="32" r="26"/></clipPath><pattern id="varseal-grain" width="5" height="5" patternUnits="userSpaceOnUse" fill="#0d0a08"><circle cx=".8" cy="1.2" r=".5"/><circle cx="3.1" cy="2.3" r=".38"/><circle cx="2" cy="4.1" r=".44"/></pattern></defs><circle cx="32" cy="32" r="31" fill="var(--ink-deep,#0d0a08)"/><circle cx="32" cy="32" r="26" fill="var(--ambre,#e9a33c)"/><g fill="var(--kraft,#e7d9be)"><circle cx="32" cy="3.5" r="1.7"/><circle cx="56.7" cy="17.8" r="1.7"/><circle cx="56.7" cy="46.2" r="1.7"/><circle cx="32" cy="60.5" r="1.7"/><circle cx="7.3" cy="46.2" r="1.7"/><circle cx="7.3" cy="17.8" r="1.7"/></g><g clip-path="url(#varseal-disc)" fill="var(--ink-deep,#0d0a08)"><path d="M31.6 35.8 31.4 41.6c-7 1.4-13.6 6.4-17.2 13.2L12.8 64h38.4l-1.4-9c-3.4-6.8-6.6-11.2-11.8-13.4l-.2-5.8Z"/><g transform="rotate(-4 32 34) translate(6.3 5) scale(.81)"><path d="M33 15.2c5.4.4 8.6 3.6 9 8.2.1.6-.1 1.2-.6 1.6 2 1.8 5.2 4.9 5.2 6.1 0 .8-1.8 1.1-3.6 1.4 1 .9 1.1 2.1.4 3.1.9.8 1.1 2 .4 3-.8 1.2-3.2 2.1-6.2 2.2-2.8.1-5.2-.6-6.6-1.8-.6-.6-.9-1.4-1-2.4V15.2Z"/><circle cx="29" cy="22" r="11"/><circle cx="37" cy="15.3" r="2.7"/><circle cx="31.7" cy="12" r="3.3"/><circle cx="23.8" cy="13" r="3.3"/><circle cx="19" cy="19.3" r="3.3"/><circle cx="20" cy="27.2" r="3.3"/><circle cx="25.4" cy="31.8" r="3.3"/><circle cx="30.6" cy="32.5" r="4"/></g></g><circle cx="32" cy="32" r="26" fill="url(#varseal-grain)" opacity=".12"/></svg><blockquote class="var-quote__line" lang="en">The absence of evidence is not the evidence of absence</blockquote><figcaption class="var-quote__by">The Boondocks</figcaption></figure>`;

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
    NOT_FOUND: ["Aucun lien retrouvé", "Pas de verdict automatique : la table tranche."],
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
  return `<section class="var-panel var-panel--${verdict.toLowerCase()}"><span class="var-panel__status">${escapeHtml(copy[0])}</span>${verdict === "NOT_FOUND" ? NOT_FOUND_QUOTE : ""}<p>${escapeHtml(copy[1])}</p>${verificationCascadeMarkup(verification)}${evidence ? `<div class="var-evidence"><small>Indices récoltés</small><ul>${evidence}</ul></div>` : ""}<div class="var-links" aria-label="Recherches manuelles">${links}</div></section>`;
}
