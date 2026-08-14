// The frame every routed screen sits in: the two sprocket rails, the grain, a back link and the studio mark.
// The decorative eyebrow that used to occupy the right third of the bar is gone — it named the screen a second
// time, in a place no player looked.

import { app, routeUrl } from "./runtime.js";

export function brandMarkup(large = false) {
  return `<a class="brand ${large ? "brand--large" : ""}" href="${routeUrl("/")}" data-nav aria-label="Ciné-Fil, accueil"><span class="brand__seal" aria-hidden="true">CF</span><span class="brand__words"><b>Ciné</b><em>Fil</em></span></a>`;
}

export function filmFurniture() {
  return `<div class="reel-rail reel-rail--left" aria-hidden="true"></div><div class="reel-rail reel-rail--right" aria-hidden="true"></div><div class="film-grain" aria-hidden="true"></div>`;
}

export function shell(content, { back = null } = {}) {
  // Screens author logical routes; the shell rewrites them for a build served from a repository subpath.
  const routedContent = String(content).replace(/href="(\/[^"#?]*)"/g, (_, route) => (
    `href="${app.basePath !== "/" && route.startsWith(app.basePath) ? route : routeUrl(route)}"`
  ));
  const backLink = back
    ? `<a class="back-link" href="${routeUrl(back)}" data-nav><span aria-hidden="true">←</span> ${back === "/" ? "Accueil" : "Jeu"}</a>`
    : "<span></span>";
  return `<main class="page">${filmFurniture()}<header class="topbar">${backLink}${brandMarkup()}</header><div class="page__body">${routedContent}</div></main>`;
}
