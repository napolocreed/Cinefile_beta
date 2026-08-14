// The end credits. Between the last life lost and the scoreboard, the game rolls its own closing titles: the cast
// in the order they were billed, the chain in the order it appeared with the film that holds each pair together,
// the artists who were named but never retained, the bluff ledger — including the bluffs nobody ever called, which
// is the only place they are ever revealed — and the sequence log, act by act.
//
// The roll is long by design, so it is skippable by design too: a tap anywhere on the stage, Échap, Entrée or the
// space bar send the table straight to the scores. The data is assembled during the game (see runtime.js), never
// here: this module only dresses it.

import { app, creditsFor, navigate, state } from "../runtime.js";
import { escapeHtml } from "../format.js";
import { shell } from "../shell.js";

// Slow enough to read a name, fast enough that a long game does not outstay the table's patience.
const ROLL_SPEED = 58;
const ROLL_MIN_SECONDS = 14;
const ROLL_MAX_SECONDS = 105;

const ROLE_LABELS = {
  survivor: "Le dernier à l’écran",
  illusionist: "Cascades sans doublure",
  editor: "Au montage",
  archivist: "À la documentation",
  understudy: "Doublure démasquée",
  lead: "Premier rôle",
  supporting: "Second rôle",
};

const SCENE_LABELS = {
  opening: "Ouverture",
  link: "Raccord",
  "challenge-failed": "Fausse alerte",
  "bluff-slipped": "Cascade non créditée",
  "bluff-unmasked": "Coupez !",
  timeout: "Hors champ",
  "broken-link": "Raccord manqué",
};

const plural = (count, word, suffix = "s") => `${count} ${word}${count > 1 ? suffix : ""}`;

function formatDate(timestamp) {
  if (!timestamp) return "";
  try {
    return new Date(timestamp).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return "";
  }
}

function formatDuration(durationMs) {
  if (!durationMs) return "";
  const minutes = Math.round(durationMs / 60000);
  if (minutes < 1) return "moins d’une minute de projection";
  return `${plural(minutes, "minute")} de projection`;
}

// A prolific pair can share a dozen titles, and a credit roll that lists them all stops being a credit roll.
function filmLine(films, limit = 3) {
  const shown = films.slice(0, limit).map((film) => escapeHtml(film)).join(" · ");
  const rest = films.length - limit;
  return rest > 0 ? `${shown} <em>et ${rest} autre${rest > 1 ? "s" : ""}</em>` : shown;
}

/* -----------------------------------------------------------------------------
   The cards
   -------------------------------------------------------------------------- */

function titleCard(credits) {
  const title = credits.opening && credits.closing && credits.opening !== credits.closing
    ? `De ${credits.opening}<br>à ${credits.closing}`
    : credits.opening
      ? `Autour de<br>${credits.opening}`
      : "Bobine vierge";
  const stamp = [formatDate(credits.startedAt), formatDuration(credits.durationMs)].filter(Boolean).join(" · ");
  return `<div class="roll-card roll-card--title">
    <p class="roll-studio">Ciné-Fil présente</p>
    <h1 class="roll-title">${title}</h1>
    <p class="roll-subtitle">${plural(credits.tally.actors, "acteur")} à l’affiche · ${plural(credits.tally.acts, "séquence")}</p>
    ${stamp ? `<p class="roll-stamp">${escapeHtml(stamp)}</p>` : ""}
  </div>`;
}

function directorCard(credits) {
  if (!credits.winnerName) return "";
  return `<div class="roll-card roll-card--single">
    <p class="roll-role">Mise en scène</p>
    <p class="roll-headline">${escapeHtml(credits.winnerName)}</p>
  </div>`;
}

function castCredit(member) {
  const notes = [
    member.links ? plural(member.links, "raccord") : null,
    member.filmsFound ? plural(member.filmsFound, "film") : null,
    member.bluffsSlipped ? `${plural(member.bluffsSlipped, "bluff")} jamais démasqué${member.bluffsSlipped > 1 ? "s" : ""}` : null,
    member.bluffsUnmasked ? `${plural(member.bluffsUnmasked, "bluff")} démasqué${member.bluffsUnmasked > 1 ? "s" : ""}` : null,
    member.challengesWon ? `${plural(member.challengesWon, "buzz")} juste${member.challengesWon > 1 ? "s" : ""}` : null,
    member.bestStreak > 1 ? `série de ${member.bestStreak}` : null,
  ].filter(Boolean);
  return notes.join(" · ");
}

function castCard(credits) {
  return `<section class="roll-block">
    <h2 class="roll-heading">Distribution</h2>
    <ul class="roll-cast">${credits.cast.map((member) => `<li class="roll-cast__row ${member.winner ? "roll-cast__row--winner" : ""}">
      <b>${escapeHtml(member.name)}</b>
      <span>${escapeHtml(ROLE_LABELS[member.role] ?? ROLE_LABELS.supporting)}</span>
      <small>${escapeHtml(castCredit(member))}${member.eliminatedAt ? `${castCredit(member) ? " · " : ""}sorti à la séquence ${member.eliminatedAt}` : ""}</small>
    </li>`).join("")}</ul>
  </section>`;
}

// The chain, read as a filmography: two names and, between them, the film that lets one follow the other. When
// nothing links them, the roll says so — that is the bluff nobody caught, finally credited.
function reelCard(credits) {
  if (!credits.reel.length) return "";
  return `<section class="roll-block">
    <h2 class="roll-heading">Dans l’ordre d’apparition</h2>
    <ol class="roll-chain">${credits.reel.map((entry) => {
      const link = !entry.from
        ? `<p class="roll-chain__open">Premier plan · ${escapeHtml(entry.playerName ?? "")}</p>`
        : entry.films.length
          ? `<p class="roll-chain__films ${entry.redeemed ? "roll-chain__films--late" : ""}">${filmLine(entry.films)}${entry.redeemed ? " <em>(retrouvé aux archives)</em>" : ""}</p>`
          : `<p class="roll-chain__films roll-chain__films--none">aucun film commun</p>`;
      const badge = entry.bluff && !entry.redeemed
        ? `<span class="roll-badge roll-badge--bluff">Bluff jamais démasqué</span>`
        : entry.challenged
          ? `<span class="roll-badge roll-badge--held">Buzzé, et pourtant vrai</span>`
          : "";
      return `<li class="roll-chain__link ${entry.bluff && !entry.redeemed ? "roll-chain__link--bluff" : ""}">
        ${entry.from ? `<span class="roll-chain__arrow" aria-hidden="true">│</span>` : ""}
        ${link}
        <p class="roll-chain__actor">${escapeHtml(entry.actor)}</p>
        <p class="roll-chain__by">amené par ${escapeHtml(entry.playerName ?? "la table")}</p>
        ${badge}
      </li>`;
    }).join("")}</ol>
  </section>`;
}

function guestReason(guest) {
  if (guest.kind === "bluff-unmasked") return guest.challengerName ? `bluff démasqué par ${guest.challengerName}` : "bluff démasqué";
  if (guest.kind === "timeout") return "hors délai";
  return "raccord refusé";
}

function guestsCard(credits) {
  if (!credits.guests.length) return "";
  return `<section class="roll-block">
    <h2 class="roll-heading">Avec la participation de</h2>
    <ul class="roll-guests">${credits.guests.map((guest) => `<li>
      <b>${escapeHtml(guest.name)}</b>
      <small>proposé par ${escapeHtml(guest.playerName ?? "la table")} · ${escapeHtml(guestReason(guest))}</small>
    </li>`).join("")}</ul>
  </section>`;
}

// The point of the whole reel: a bluff that was called got its moment on the challenge screen, a bluff that was
// not has never been said out loud. Here it is, with the pair it was built on.
function bluffCard(credits) {
  const { slipped, unmasked, falseAlarms } = credits.bluffs;
  if (!slipped.length && !unmasked.length && !falseAlarms.length) return "";
  const row = (scene, modifier, note) => `<li class="roll-bluff ${modifier}">
    <p class="roll-bluff__pair">${escapeHtml(scene.from ?? "—")} <span aria-hidden="true">→</span> ${escapeHtml(scene.actor ?? "—")}</p>
    <p class="roll-bluff__note">${note}</p>
    <p class="roll-bluff__act">Séquence ${scene.act}</p>
  </li>`;
  return `<section class="roll-block">
    <h2 class="roll-heading">Cascades et doublures</h2>
    <ul class="roll-bluffs">
      ${slipped.map((scene) => row(scene, "roll-bluff--slipped", `<b>${escapeHtml(scene.playerName ?? "")}</b> a bluffé et personne n’a bronché.`)).join("")}
      ${unmasked.map((scene) => row(scene, "roll-bluff--unmasked", `<b>${escapeHtml(scene.challengerName ?? "La table")}</b> a démasqué ${escapeHtml(scene.playerName ?? "")}.`)).join("")}
      ${falseAlarms.map((scene) => row(scene, "roll-bluff--false", `<b>${escapeHtml(scene.challengerName ?? "La table")}</b> a crié au bluff : la pellicule disait le contraire.`)).join("")}
    </ul>
    ${slipped.length ? `<p class="roll-note">${slipped.length > 1 ? "Ces liaisons n’ont jamais existé" : "Cette liaison n’a jamais existé"} : elles sont restées dans la chaîne faute d’avoir été contestées.</p>` : ""}
  </section>`;
}

function sceneNarration(scene) {
  const films = scene.films.length ? ` — ${filmLine(scene.films)}` : "";
  const who = escapeHtml(scene.playerName ?? "La table");
  const actor = escapeHtml(scene.actor ?? "—");
  const from = escapeHtml(scene.from ?? "—");
  const challenger = escapeHtml(scene.challengerName ?? "Le voisin");
  switch (scene.kind) {
    case "opening": return `${who} ouvre la bobine sur <b>${actor}</b>.`;
    case "link": return `${who} enchaîne sur <b>${actor}</b>${films}.`;
    case "challenge-failed": return `${challenger} crie au bluff ; la pellicule donne raison à ${who}${films}.`;
    case "bluff-slipped": return `${who} glisse <b>${actor}</b> après ${from} sans le moindre film commun. Personne ne bronche.`;
    case "bluff-unmasked": return `${challenger} démasque ${who} : rien ne relie ${from} à <b>${actor}</b>.`;
    case "timeout": return `Le chrono coupe la réplique de ${who}.`;
    default: return `${who} propose <b>${actor}</b> ; le raccord ne tient pas.`;
  }
}

function sceneToll(scene) {
  if (!scene.struckName) return "";
  const name = escapeHtml(scene.struckName);
  if (scene.eliminated) return `<p class="roll-log__toll roll-log__toll--out">${name} quitte le plateau.</p>`;
  return `<p class="roll-log__toll">${name} perd une vie · ${plural(scene.livesLeft ?? 0, "restante")}.</p>`;
}

function logCard(credits) {
  if (!credits.scenes.length) return "";
  return `<section class="roll-block">
    <h2 class="roll-heading">Séquencier</h2>
    <ol class="roll-log">${credits.scenes.map((scene) => `<li class="roll-log__scene roll-log__scene--${scene.kind}">
      <p class="roll-log__slate"><span>${String(scene.act).padStart(2, "0")}</span>${escapeHtml(SCENE_LABELS[scene.kind] ?? "Séquence")}</p>
      <p class="roll-log__line">${sceneNarration(scene)}</p>
      ${sceneToll(scene)}
      ${scene.manual ? `<p class="roll-log__note">Décision rendue par la table après consultation des archives.</p>` : ""}
    </li>`).join("")}</ol>
  </section>`;
}

function technicalCard(credits) {
  const { tally } = credits;
  const rows = [
    ["Chaîne", `${plural(tally.actors, "acteur")} · ${plural(tally.links, "raccord")}`],
    ["Filmographie", plural(tally.films, "film")],
    ["Bluffs tentés", String(tally.bluffsAttempted)],
    ["Bluffs jamais démasqués", String(tally.bluffsSlipped)],
    ["Bluffs démasqués", String(tally.bluffsUnmasked)],
    ["Buzz", `${tally.challenges} · ${tally.challengesRight} juste${tally.challengesRight > 1 ? "s" : ""}, ${tally.challengesWrong} à côté`],
    tally.varDecisions ? ["Passages à la VAR", String(tally.varDecisions)] : null,
    tally.timeouts ? ["Répliques hors délai", String(tally.timeouts)] : null,
    ["Vies dépensées", String(tally.livesLost)],
    tally.longestStreak > 1 ? ["Plus longue série", String(tally.longestStreak)] : null,
  ].filter(Boolean);
  return `<section class="roll-block">
    <h2 class="roll-heading">Générique technique</h2>
    <dl class="roll-technical">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
  </section>`;
}

function endCard() {
  return `<div class="roll-card roll-card--end">
    <p class="roll-fin">Fin</p>
    <p class="roll-fineprint">Toute ressemblance avec une filmographie existante n’est jamais un hasard.</p>
    <p class="roll-fineprint">Données de films et d’artistes : TMDb, Wikidata, Wikipédia.</p>
  </div>`;
}

/* -----------------------------------------------------------------------------
   The screen
   -------------------------------------------------------------------------- */

function creditsMarkup(credits) {
  return `<section class="screen end-credits" data-credits>
    <div class="credits-viewport" data-credits-viewport>
      <div class="credits-roll" data-credits-roll>
        ${titleCard(credits)}
        ${directorCard(credits)}
        ${castCard(credits)}
        ${reelCard(credits)}
        ${guestsCard(credits)}
        ${bluffCard(credits)}
        ${logCard(credits)}
        ${technicalCard(credits)}
        ${endCard()}
      </div>
    </div>
    <div class="credits-controls">
      <p class="credits-hint">Touchez l’écran pour passer le générique</p>
      <button class="button button--gold" data-credits-skip>Voir les scores <span aria-hidden="true">→</span></button>
    </div>
  </section>`;
}

// A key listener has to live on the document to catch anything, and the router repaints without telling anyone,
// so the screen hands back its own teardown and calls it before leaving.
let detachCredits = null;

export function stopCredits() {
  detachCredits?.();
  detachCredits = null;
}

export function renderCredits() {
  stopCredits();
  const game = state.game ?? app.storage.loadCurrent();
  if (!game || game.status !== "finished") {
    navigate("/results");
    return;
  }
  state.game = game;
  // The engine has no clock, so the moment the credits first roll is the closest honest end time there is.
  if (!game.finishedAt) {
    game.finishedAt = Date.now();
    app.storage.saveCurrent(game);
  }
  const credits = creditsFor(game);
  if (!credits) {
    navigate("/results");
    return;
  }
  app.root.innerHTML = shell(creditsMarkup(credits));
  bindCredits();
}

function bindCredits() {
  const stage = document.querySelector("[data-credits]");
  const viewport = document.querySelector("[data-credits-viewport]");
  const roll = document.querySelector("[data-credits-roll]");
  if (!stage || !viewport || !roll) return;

  const toResults = () => {
    stopCredits();
    navigate("/results");
  };

  const onKey = (event) => {
    if (!["Enter", " ", "Spacebar", "Escape"].includes(event.key)) return;
    // The skip button answers its own key presses; letting the document answer too would fire twice.
    if (event.target.closest?.("[data-credits-skip]")) return;
    event.preventDefault();
    toResults();
  };

  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  if (reduced) {
    // No roll, no animationend: the whole thing becomes a document the table scrolls at its own pace.
    viewport.classList.add("credits-viewport--static");
  } else {
    const travel = roll.scrollHeight + viewport.clientHeight;
    const duration = Math.min(ROLL_MAX_SECONDS, Math.max(ROLL_MIN_SECONDS, travel / ROLL_SPEED));
    roll.style.setProperty("--roll-from", `${viewport.clientHeight}px`);
    roll.style.setProperty("--roll-to", `-${roll.scrollHeight}px`);
    roll.style.setProperty("--roll-duration", `${duration.toFixed(1)}s`);
    roll.classList.add("credits-roll--playing");
    roll.addEventListener("animationend", toResults, { once: true });
  }

  stage.addEventListener("click", toResults);
  document.addEventListener("keydown", onKey);
  detachCredits = () => {
    stage.removeEventListener("click", toResults);
    document.removeEventListener("keydown", onKey);
  };
}
