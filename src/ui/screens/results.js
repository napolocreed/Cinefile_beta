// End credits. The winner's card, the standings, and the reel that got played.

import { ACHIEVEMENTS } from "../../game/achievements.js";
import { createGame } from "../../game/engine.js";
import { recordFinishedGame } from "../../game/storage.js";
import { app, navigate, routeUrl, state } from "../runtime.js";
import { escapeHtml } from "../format.js";
import { shell } from "../shell.js";

export function renderResults() {
  const game = state.game ?? app.storage.loadCurrent();
  if (!game || game.status !== "finished") {
    app.root.innerHTML = shell(`<section class="screen empty-state">
      <span class="stamp stamp--ambre">Salle vide</span>
      <h1 class="marquee">Aucune partie terminée</h1>
      <a class="button button--gold" href="${routeUrl("/setup")}" data-nav>Tourner une partie</a>
    </section>`, { back: "/" });
    return;
  }

  state.game = game;
  const result = recordFinishedGame(game, app.storage);
  state.newAchievements = result.newAchievements;
  const ordered = [...game.players].sort((left, right) => (right.id === game.winnerId) - (left.id === game.winnerId) || right.score - left.score);
  const winner = game.players.find((player) => player.id === game.winnerId);
  const newAchievements = state.newAchievements
    .map((id) => ACHIEVEMENTS.find((achievement) => achievement.id === id))
    .filter(Boolean);

  app.root.innerHTML = shell(`<section class="results-page">
    <div class="stub stub--kraft credits-card">
      <span class="slug">Dans le rôle du vainqueur</span>
      <h1>${escapeHtml(winner?.name ?? "Personne")}</h1>
      <p class="fineprint">Une chaîne de ${game.chain.length} acteur${game.chain.length > 1 ? "s" : ""}</p>
    </div>

    <div class="block">
      <div class="block__head"><span class="slug slug--ambre">Le classement</span></div>
      <ol class="ranking">${ordered.map((player, index) => `<li class="ranking__row ${player.id === game.winnerId ? "ranking__row--winner" : ""}"><span class="ranking__place">#${index + 1}</span><strong>${escapeHtml(player.name)}</strong><span>${player.filmsFound} films · ${player.score} pts · série ${player.bestStreak}</span></li>`).join("")}</ol>
    </div>

    ${newAchievements.length ? `<div class="block">
      <div class="block__head"><span class="slug slug--ambre">Nouveau succès</span></div>
      <div class="achievement-list">${newAchievements.map((achievement) => `<div class="achievement"><span aria-hidden="true">${achievement.icon}</span><div><b>${escapeHtml(achievement.label)}</b><small>${escapeHtml(achievement.description)}</small></div></div>`).join("")}</div>
    </div>` : ""}

    <details class="fold">
      <summary>Chaîne complète</summary>
      <div class="fold__body">
        <p class="chain-line">${game.chain.map((actor, index) => `<span>${escapeHtml(actor)}</span>${index < game.chain.length - 1 ? "<b>→</b>" : ""}`).join("")}</p>
      </div>
    </details>

    <div class="results-actions">
      <button class="button button--gold" data-replay>Rejouer <span aria-hidden="true">↗</span></button>
      <a class="button button--ghost" href="/" data-nav>Accueil</a>
    </div>
  </section>`, { back: "/" });

  document.querySelector("[data-replay]")?.addEventListener("click", () => {
    const names = game.players.map((player) => player.name);
    state.game = createGame({ names, config: game.config });
    app.storage.saveCurrent(state.game);
    navigate("/play");
  });
}
