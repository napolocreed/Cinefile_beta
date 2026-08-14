// The poster. One screen, no scroll: the mark, the title, two ways in.

import { app, routeUrl, state } from "../runtime.js";
import { brandMarkup, filmFurniture } from "../shell.js";

export function renderHome() {
  const hasGame = state.game?.status === "in-progress";
  app.root.innerHTML = `<main class="hero"><div class="hero__beam" aria-hidden="true"></div>${filmFurniture()}<div class="hero__content">
    <div class="hero__mark">${brandMarkup(true)}</div>
    <div class="screen__spacer screen__spacer--half"></div>
    <h1 class="marquee hero__title">Le dernier <em>à l’écran</em></h1>
    <p class="prose hero__pitch">Reliez chaque acteur au précédent par un film commun. Bluffez, démasquez, survivez.</p>
    <div class="screen__spacer"></div>
    <div class="hero__actions">
      <a class="button button--gold" href="${routeUrl("/setup")}" data-nav>Nouvelle partie <span aria-hidden="true">→</span></a>
      ${hasGame ? `<a class="button button--ghost" href="${routeUrl("/play")}" data-nav>Reprendre la partie <span aria-hidden="true">↗</span></a>` : ""}
      <a class="button button--text" href="${routeUrl("/profiles")}" data-nav>Profils &amp; succès</a>
    </div>
    <p class="fineprint hero__billing">Sans compte · sans connexion · sur cet appareil</p>
  </div></main>`;
}
