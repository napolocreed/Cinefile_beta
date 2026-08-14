// Small markup helpers shared by every screen: escaping, portraits, and the two glyph rows the game leans on.

import { app, state } from "./runtime.js";

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
})[character]);

export function initialOf(name) {
  return escapeHtml(String(name ?? "?").trim().slice(0, 1).toLocaleUpperCase("fr") || "?");
}

export function pictureMarkup(path, name, className, emptyClassName) {
  if (!path) return `<span class="${emptyClassName}" aria-hidden="true">${initialOf(name)}</span>`;
  return `<img class="${className}" src="${escapeHtml(path)}" alt="" loading="lazy" decoding="async" data-initial="${initialOf(name)}" data-fallback="${emptyClassName}">`;
}

export function portraitMarkup(candidate, modifier = "") {
  const path = candidate?.profilePath ?? app.database?.findActor(candidate?.name)?.profilePath ?? null;
  return pictureMarkup(path, candidate?.name, `portrait ${modifier}`, `portrait ${modifier} portrait--empty`);
}

// Portraits come from a remote image host. Offline, or behind a filtering network, the frame falls back to an
// engraved initial rather than a broken image.
export function installPortraitFallback() {
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.initial) return;
    const replacement = document.createElement("span");
    replacement.className = image.dataset.fallback ?? "";
    replacement.setAttribute("aria-hidden", "true");
    replacement.textContent = image.dataset.initial;
    image.replaceWith(replacement);
  }, true);
}

// Every life ever held keeps its slot — a lost one turns into a spent sprocket hole rather than disappearing.
// Rendering only the surviving lives made a loss invisible: the row just got one glyph shorter.
export function livesMarkup(lives, large = false, { capacity = null, dying = false } = {}) {
  const slots = Math.max(1, capacity ?? state.game?.config?.livesPerPlayer ?? lives, lives);
  const perforations = Array.from({ length: slots }, (_, index) => {
    const lost = index >= lives;
    const justLost = dying && index === lives;
    return `<span class="heart ${lost ? "heart--off" : "heart--on"} ${justLost ? "heart--dying" : ""}"></span>`;
  });
  return `<span class="lives ${large ? "lives--large" : ""}" aria-label="${lives} vie${lives > 1 ? "s" : ""} sur ${slots}">${perforations.join("")}</span>`;
}

export function roleLabel(person) {
  const role = person.roles?.[0] ?? "artist";
  return ({
    acting: "Interprète",
    directing: "Réalisation",
    writing: "Scénario",
    production: "Production",
    artist: "Artiste",
  })[role] ?? role;
}
