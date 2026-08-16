// The studio archives. The trophy cabinet used to unfurl on every visit and cost most of the scroll; it is folded
// away now, while the tools that people actually come here for stay in the open.
//
// A card shows four counters, three gauges, and nothing else by default. Everything else the archives know — the
// full ledger, the reel of the last fifty games, the honour roll — lives in one fold per card: consultation is
// passive, and a fold is the modal this repository already owns.

import { ACHIEVEMENTS, FAMILIES, TIERS, achievementById, levelForXp, progressFor } from "../../game/achievements.js";
import { CATALOG_CACHE_KEY, VERIFICATION_CACHE_KEY } from "../../game/catalog.js";
import { EMPTY_ARCHIVE, buildArchiveIndex, ratio } from "../../game/statistics.js";
import { profileKey } from "../../game/storage.js";
import { backupFilename, createBackup, parseBackup, restoreBackup } from "../../game/transfer.js";
import { app, assetUrl, state } from "../runtime.js";
import { escapeHtml } from "../format.js";
import { shell } from "../shell.js";

// L'écran se réécrit en entier à chaque réglage : sans cette mémoire, un repli ouvert se refermerait sous le doigt.
const openFolds = new Set();

/* -----------------------------------------------------------------------------
   Formats
   -------------------------------------------------------------------------- */

const percent = (rate) => (rate === null ? "—" : `${Math.round(rate * 100)} %`);
const decimal = (value, digits = 1) => value.toFixed(digits).replace(".", ",");
const count = (value) => Number(value ?? 0).toLocaleString("fr-FR");

function duration(ms) {
  if (!ms) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

function shortDate(timestamp) {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return null;
  }
}

function sinceDate(timestamp) {
  if (!timestamp) return null;
  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (days <= 0) return "aujourd’hui";
  if (days === 1) return "hier";
  if (days < 30) return `il y a ${days} jours`;
  return shortDate(timestamp);
}

/* -----------------------------------------------------------------------------
   Les trois jauges
   -------------------------------------------------------------------------- */

function gaugeMarkup(label, rate, base) {
  return `<div class="gauge ${rate === null ? "gauge--void" : ""}">
    <span class="gauge__label">${escapeHtml(label)}</span>
    <b class="gauge__value">${percent(rate)}</b>
    <span class="gauge__track"><span class="gauge__fill" style="--fill:${Math.round((rate ?? 0) * 100)}%"></span></span>
    <span class="gauge__base">${escapeHtml(base)}</span>
  </div>`;
}

// Un pourcentage seul est indéfendable ; le même pourcentage avec sa fraction dessous se vérifie d'un coup d'œil.
function gaugesMarkup(profile) {
  const bluff = ratio(profile.bluffsSucceeded, profile.bluffsAttempted, 5);
  const buzz = ratio(profile.challengesSuccessful, profile.challengesMade, 5);
  const table = ratio(profile.rankShareSum, profile.games, 3);
  return `<div class="gauges">
    ${gaugeMarkup("Bluffs réussis", bluff, bluff === null ? "dès 5 bluffs" : `${profile.bluffsSucceeded} / ${profile.bluffsAttempted}`)}
    ${gaugeMarkup("Fiabilité au buzzer", buzz, buzz === null ? "dès 5 buzz" : `${profile.challengesSuccessful} / ${profile.challengesMade}`)}
    ${gaugeMarkup("Tenue de table", table, table === null ? "dès 3 parties" : `sur ${profile.games} partie${profile.games > 1 ? "s" : ""}`)}
  </div>`;
}

/* -----------------------------------------------------------------------------
   Le registre
   -------------------------------------------------------------------------- */

// Une valeur sans socle prend le tiret et perd son ambre : elle ne se lit pas comme un résultat.
const row = (label, value, { note = "", void: isVoid = false } = {}) => (value === null || value === undefined
  ? ""
  : `<div class="ledger__row"><dt>${escapeHtml(label)}</dt><dd${isVoid ? " data-void" : ""}>${value}${note ? ` <small>${escapeHtml(note)}</small>` : ""}</dd></div>`);

const ledger = (rows) => (rows.filter(Boolean).length ? `<dl class="ledger">${rows.filter(Boolean).join("")}</dl>` : "");

const section = (title, rows) => (rows.filter(Boolean).length
  ? `<div class="fiche__section"><p class="slug slug--ambre">${escapeHtml(title)}</p>${ledger(rows)}</div>`
  : "");

// Un nom propre ne tient pas dans une tuile : il prend sa ligne, en capitales, son décompte à droite.
const factLine = (label, entry, suffix) => (entry
  ? `<div class="fact"><span class="fact__label">${escapeHtml(label)}</span><b class="fact__name">${escapeHtml(entry.label ?? entry.name)}</b><span class="fact__count">${escapeHtml(suffix(entry))}</span></div>`
  : "");

function formStrip(stats) {
  if (stats.recentGames < 5) return "";
  // La hauteur est relative à la plus longue chaîne de la série : une bande calée sur un maximum absolu
  // écraserait toutes les petites parties au ras du sol.
  const shown = stats.form.slice(0, 10).reverse();
  const ceiling = Math.max(3, ...shown.map((entry) => entry.chain));
  const frames = [
    ...Array.from({ length: Math.max(0, 10 - shown.length) }, () => `<span class="strip__frame strip__frame--blank"></span>`),
    ...shown.map((entry) => `<span class="strip__frame ${entry.won ? "strip__frame--win" : ""}" style="--h:${Math.round((entry.chain / ceiling) * 100)}%"></span>`),
  ].join("");
  const spoken = shown.map((entry) => (entry.won ? "victoire" : "défaite")).join(", ");
  return `<div class="strip" role="img" aria-label="Dix dernières parties, de la plus ancienne à la plus récente : ${escapeHtml(spoken)}">${frames}</div>`;
}

/* -----------------------------------------------------------------------------
   Le tableau d'honneur
   -------------------------------------------------------------------------- */

function achievementMarkup(achievement, { earned, progress = null, reveal = true }) {
  const hidden = achievement.secret && !earned && !reveal;
  const label = hidden ? "Succès secret" : achievement.label;
  const description = hidden ? "Il se découvre en jouant." : achievement.description;
  return `<div class="trophy trophy--${achievement.tier} ${earned ? "trophy--earned" : ""}">
    <span class="trophy__icon" aria-hidden="true">${hidden ? "🔒" : achievement.icon}</span>
    <div class="trophy__body">
      <b>${escapeHtml(label)}</b>
      <small>${escapeHtml(description)}</small>
      ${progress && !earned ? `<span class="trophy__track"><span class="trophy__fill" style="--fill:${Math.round((progress.value / progress.target) * 100)}%"></span></span>
      <span class="trophy__count">${count(progress.value)} / ${count(progress.target)}</span>` : ""}
    </div>
    <span class="trophy__tier">${escapeHtml(TIERS[achievement.tier] ?? achievement.tier)}</span>
  </div>`;
}

// Ce qui est presque décroché vaut mieux que ce qui est loin : trois lignes suffisent à donner envie de rejouer.
function nextUp(profile) {
  const earned = new Set(profile.achievements ?? []);
  return ACHIEVEMENTS
    .filter((achievement) => !earned.has(achievement.id) && !achievement.secret)
    .map((achievement) => ({ achievement, progress: progressFor(achievement, profile) }))
    .filter((entry) => entry.progress && entry.progress.value > 0)
    .sort((left, right) => (right.progress.value / right.progress.target) - (left.progress.value / left.progress.target))
    .slice(0, 3);
}

/* -----------------------------------------------------------------------------
   La fiche complète
   -------------------------------------------------------------------------- */

function ficheMarkup(profile, stats) {
  const key = profileKey(profile.name);
  // Une fiche antérieure à la migration a des parties mais aucun détail : ses lignes prennent le tiret plutôt que
  // d'afficher des zéros qui se liraient comme des résultats.
  const detailed = profile.rankSum > 0;
  const missing = !detailed && profile.games > 0;
  const earned = profile.achievements?.length ?? 0;
  const winRate = ratio(profile.wins, profile.games, 3);
  const turnRate = ratio(profile.links, profile.turnsPlayed, 20);
  const buzzRate = ratio(profile.challengesMade, profile.challengeChances, 10);

  const palmares = section("Le palmarès", [
    row("Parties jouées", count(profile.games)),
    row("Victoires", count(profile.wins)),
    row("Taux de victoire", percent(winRate), { void: winRate === null }),
    row("Place moyenne", detailed ? `${decimal(profile.rankSum / profile.games)}ᵉ` : "—", { void: !detailed }),
    row("Table moyenne", detailed ? `${decimal(profile.tableSeats / profile.games)} joueurs` : "—", { void: !detailed }),
    row("Série de victoires", profile.streakRun > 0 ? `${profile.streakRun} d’affilée` : "—", { void: profile.streakRun <= 0 }),
    row("Meilleure série de victoires", profile.bestWinStreak ? `${profile.bestWinStreak} parties` : "—", { void: !profile.bestWinStreak }),
    row("Points marqués", count(profile.points), { void: !detailed }),
    row("Niveau", escapeHtml(levelForXp(profile.xp))),
    row("Succès décrochés", `${earned} / ${ACHIEVEMENTS.length}`),
  ]);

  const style = section("Le style de jeu", [
    row("Tours joués", count(profile.turnsPlayed), { void: !detailed }),
    row("Liaisons validées", count(profile.links), { void: !detailed }),
    row("Réussite au tour", percent(turnRate), { void: turnRate === null }),
    row("Films crédités", count(profile.filmsFound), { note: "liaison sans preuve comprise" }),
    row("Chaînes ouvertes", count(profile.openings), { void: !detailed }),
    row("Bluffs tentés", count(profile.bluffsAttempted), { void: !detailed }),
    row("Bluffs passés", count(profile.bluffsSucceeded)),
    row("Bluffs sanctionnés", count(profile.bluffsCaught)),
    row("Occasions de buzzer", count(profile.challengeChances), { void: !detailed }),
    row("Buzz déclenchés", count(profile.challengesMade)),
    row("Bluffs démasqués", count(profile.challengesSuccessful)),
    row("Doigt sur le buzzer", percent(buzzRate), { void: buzzRate === null }),
    row("Meilleure série", profile.bestStreak ? `${profile.bestStreak} liaisons` : "—", { void: !profile.bestStreak }),
    row("Tours perdus au chrono", count(profile.timeouts), { void: !detailed }),
    row("Vies perdues", count(profile.livesLost), { void: !detailed }),
  ]);

  const bobineRows = [
    row("Visages posés", stats.distinctActors ? `${count(stats.distinctActors)} acteurs distincts` : null),
    row("Films distincts", stats.distinctFilms ? count(stats.distinctFilms) : null),
    row("La plus longue chaîne", stats.longestChain ? `${stats.longestChain.length} acteurs${shortDate(stats.longestChain.at) ? ` · ${shortDate(stats.longestChain.at)}` : ""}` : null),
    row("Durée moyenne d’une partie", duration(stats.averageMs)),
    row("Temps de projection", duration(profile.playedMs)),
    row("Séance de prédilection", stats.slot ? `${stats.slot.label} · ${stats.slot.count} séances` : null),
    row("Dernière séance", sinceDate(profile.lastPlayedAt)),
    row("Première séance", shortDate(profile.firstPlayedAt)),
  ];
  const bobineFacts = [
    factLine("Acteur fétiche", stats.favouriteActor, (entry) => `× ${entry.count}`),
    factLine("Votre entrée en matière", stats.favouriteOpening, (entry) => `× ${entry.count}`),
    factLine("Film le plus revu", stats.favouriteFilm, (entry) => `× ${entry.count}`),
    factLine("La tête qui ne passe pas", stats.nemesisActor, (entry) => `refusée × ${entry.count}`),
  ].filter(Boolean).join("");
  const bobine = bobineRows.filter(Boolean).length || bobineFacts
    ? `<div class="fiche__section"><p class="slug slug--ambre">La bobine</p>${bobineFacts ? `<div class="facts">${bobineFacts}</div>` : ""}${ledger(bobineRows)}<p class="fineprint">Sur les cinquante dernières parties archivées.</p></div>`
    : "";

  const tableFacts = [
    factLine("Partenaire le plus fidèle", stats.mostFrequent, (entry) => `${entry.games} parties`),
    factLine("Bête noire", stats.nemesis, (entry) => `vous a battu ${entry.lost} fois`),
    factLine("Votre victime préférée", stats.prey, (entry) => `battue ${entry.beaten} fois`),
  ].filter(Boolean).join("");
  const strip = formStrip(stats);
  const tableSection = strip || tableFacts
    ? `<div class="fiche__section"><p class="slug slug--ambre">À la table</p>${strip}${strip ? `<p class="fineprint">${stats.recentWins} victoire${stats.recentWins > 1 ? "s" : ""} sur les ${stats.recentGames} dernières parties.</p>` : ""}${tableFacts ? `<div class="facts">${tableFacts}</div>` : ""}${ledger([row("Parties en prise vocale", profile.voiceGames ? `${profile.voiceGames} sur ${profile.games}` : null)])}</div>`
    : "";

  const trophies = (profile.achievements ?? [])
    .map((id) => achievementById(id))
    .filter(Boolean)
    .map((achievement) => achievementMarkup(achievement, { earned: true }))
    .join("");
  const upcoming = nextUp(profile)
    .map((entry) => achievementMarkup(entry.achievement, { earned: false, progress: entry.progress }))
    .join("");
  const honourSection = `<div class="fiche__section"><p class="slug slug--ambre">Le tableau d’honneur</p>
    ${trophies ? `<div class="trophies">${trophies}</div>` : `<p class="fineprint">Aucun succès décroché pour l’instant.</p>`}
    ${upcoming ? `<p class="slug">En approche</p><div class="trophies">${upcoming}</div>` : ""}
  </div>`;

  return `<details class="fold fold--flush" data-fiche="${escapeHtml(key)}" ${openFolds.has(key) ? "open" : ""}>
    <summary>La fiche complète</summary>
    <div class="fold__body">
      ${palmares}
      ${missing ? `<p class="fineprint">Les compteurs détaillés démarrent à votre prochaine partie.</p>` : ""}
      ${style}
      ${bobine}
      ${tableSection}
      ${honourSection}
    </div>
  </details>`;
}

/* -----------------------------------------------------------------------------
   L'écran
   -------------------------------------------------------------------------- */

export function renderProfiles() {
  // La bannière se consomme à l'affichage. Rien ne la remettait à null — ni ce rendu, ni navigate(), qui
  // réinitialise pourtant huit autres champs : « Sauvegarde exportée » réapparaissait à chaque retour sur l'écran
  // comme si l'export venait d'avoir lieu, et un message d'erreur d'importation survivait à l'importation réussie
  // qui le suivait.
  const notice = state.transferNotice;
  state.transferNotice = null;
  const profiles = Object.values(app.storage.loadProfiles()).sort((left, right) => right.wins - left.wins || right.xp - left.xp || (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0));
  const diagnosticEntries = app.diagnostics.load();
  // Un seul dépouillement de l'historique pour toutes les fiches, et non un par carte.
  const archive = buildArchiveIndex(app.storage.loadHistory());
  const everEarned = new Set(profiles.flatMap((profile) => profile.achievements ?? []));

  app.root.innerHTML = shell(`<section class="profiles-page">
    <h1 class="marquee">Profils</h1>
    ${notice ? `<p class="transfer-notice ${notice.type === "error" ? "transfer-notice--error" : ""}" role="status">${escapeHtml(notice.message)}</p>` : ""}

    ${profiles.length ? `<div class="profile-list">${profiles.map((profile) => {
      // Le journal des parties appartient à toute la table : archiver une fiche n'en retire personne, sinon les
      // parties des autres joueurs seraient amputées. Mais il ne doit pas non plus rebrancher l'ancienne vie sur
      // une fiche neuve — la carte annonçait « 1 partie » pendant que la bobine disait « ×9 ». On ne lit donc le
      // journal que lorsqu'il ne raconte pas plus de parties que la fiche n'en revendique.
      const archived = archive.get(profileKey(profile.name)) ?? EMPTY_ARCHIVE;
      const stats = archived.games > profile.games ? EMPTY_ARCHIVE : archived;
      return `<article class="profile-card">
      <div class="profile-card__head"><div><h2>${escapeHtml(profile.name)}</h2><p>${escapeHtml(levelForXp(profile.xp))} · ${profile.xp} XP</p></div>${profile.games ? `<span>${profile.games} partie${profile.games > 1 ? "s" : ""}</span>` : `<span class="stamp stamp--vert">Jamais tourné</span>`}</div>
      <div class="profile-stats"><div><b>${profile.wins}</b><small>Victoires</small></div><div><b>${profile.filmsFound}</b><small>Films</small></div><div><b>${profile.bluffsSucceeded}</b><small>Bluffs</small></div><div><b>${profile.challengesSuccessful}</b><small>Démasqués</small></div></div>
      ${profile.games ? gaugesMarkup(profile) : ""}
      ${profile.achievements?.length ? `<div class="profile-achievements">${profile.achievements.slice(-4).map((id) => {
        const achievement = achievementById(id);
        return achievement ? `<span title="${escapeHtml(achievement.description)}">${achievement.icon} ${escapeHtml(achievement.label)}</span>` : "";
      }).join("")}${profile.achievements.length > 4 ? `<span class="profile-achievements__more">+ ${profile.achievements.length - 4}</span>` : ""}</div>` : ""}
      ${profile.games ? ficheMarkup(profile, stats) : `<p class="fineprint">Aucune partie jouée. La fiche s’écrit au premier générique.</p>`}
      <button class="button button--text profile-card__forget" data-forget-profile="${escapeHtml(profile.name)}">Archiver la fiche</button>
    </article>`;
    }).join("")}</div>` : `<div class="empty-state empty-state--panel">
      <span class="stamp stamp--ambre">Pas encore de générique</span>
      <p class="prose">Ajoutez un nom au casting, ou terminez une partie, pour créer le premier profil.</p>
    </div>`}

    <details class="fold" data-fiche="catalogue" ${openFolds.has("catalogue") ? "open" : ""}>
      <summary>Tous les succès <span class="fold__count">${everEarned.size} / ${ACHIEVEMENTS.length}</span></summary>
      <div class="fold__body">
        ${Object.entries(FAMILIES).map(([family, title]) => {
          const entries = ACHIEVEMENTS.filter((achievement) => achievement.family === family);
          return `<p class="slug slug--ambre">${escapeHtml(title)}</p><div class="trophies">${entries.map((achievement) => achievementMarkup(achievement, {
            earned: everEarned.has(achievement.id),
            // Un succès secret ne se lit qu'une fois décroché : l'annoncer d'avance le priverait de sa surprise.
            reveal: false,
          })).join("")}</div>`;
        }).join("")}
      </div>
    </details>

    <div class="block">
      <div class="block__head"><span class="slug slug--ambre">Vos archives</span></div>
      <div class="data-tools__buttons">
        <button class="button button--gold" data-export-backup>Exporter</button>
        <button class="button button--ghost" data-import-backup>Importer</button>
      </div>
      <input class="sr-only" type="file" accept="application/json,.json" data-backup-file>
      <p class="fineprint">Sans compte ni serveur. Une importation remplace les données locales après validation du fichier.</p>
      <label class="check-row"><input type="checkbox" data-large-text-toggle ${app.storage.loadSettings().largeText ? "checked" : ""}><span>Agrandir tous les textes</span></label>
      <label class="check-row"><input type="checkbox" data-diagnostics-toggle ${app.diagnostics.isEnabled() ? "checked" : ""}><span>Journal d’erreurs local (${diagnosticEntries.length}/30)</span></label>
      ${diagnosticEntries.length ? `<button class="button button--text" data-clear-diagnostics>Effacer le journal local</button>` : ""}
      <p class="build-stamp">Version publiée · ${escapeHtml(app.buildStamp)}</p>
    </div>

    <aside class="tmdb-credit" aria-label="Crédits des données cinéma">
      <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer"><img src="${assetUrl("assets/tmdb-logo.svg")}" alt="The Movie Database"></a>
      <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </aside>
  </section>`, { back: "/" });

  bindProfileTools();
}

function readLocalJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function downloadBackup() {
  const backup = createBackup(app.storage, {
    catalogCache: readLocalJson(CATALOG_CACHE_KEY),
    verificationCache: readLocalJson(VERIFICATION_CACHE_KEY),
  });
  const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = backupFilename();
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  state.transferNotice = { type: "success", message: "Sauvegarde exportée. Gardez ce fichier pour restaurer le jeu sur un autre appareil." };
}

async function importBackupFile(file) {
  try {
    if (!file) return;
    const backup = parseBackup(await file.text());
    const result = restoreBackup(backup, app.storage, {
      storage: localStorage,
      catalogCacheKey: CATALOG_CACHE_KEY,
      verificationCacheKey: VERIFICATION_CACHE_KEY,
    });
    state.game = result.current;
    document.documentElement.toggleAttribute("data-large-text", app.storage.loadSettings().largeText === true);
    state.transferNotice = { type: "success", message: `${result.profiles} profil${result.profiles > 1 ? "s" : ""} et ${result.games} partie${result.games > 1 ? "s" : ""} restaurés.` };
  } catch (error) {
    app.diagnostics.capture(error, { phase: "backup-import" });
    state.transferNotice = { type: "error", message: error.message };
  }
  renderProfiles();
}

function bindProfileTools() {
  // L'écran se réécrit à chaque réglage : un repli ouvert doit le rester.
  document.querySelectorAll("[data-fiche]").forEach((fold) => fold.addEventListener("toggle", () => {
    if (fold.open) openFolds.add(fold.dataset.fiche);
    else openFolds.delete(fold.dataset.fiche);
  }));

  // Une suppression ne doit jamais partir au premier tap, et le dépôt n'a pas de modale : le bouton demande
  // confirmation en devenant lui-même la confirmation, et se rétracte si le doigt part ailleurs.
  document.querySelectorAll("[data-forget-profile]").forEach((button) => {
    const settle = () => {
      button.textContent = "Archiver la fiche";
      button.classList.remove("button--armed");
      delete button.dataset.armed;
    };
    button.addEventListener("blur", settle);
    button.addEventListener("click", () => {
      if (!button.dataset.armed) {
        button.dataset.armed = "true";
        button.textContent = "Confirmer l’archivage ?";
        button.classList.add("button--armed");
        return;
      }
      const name = button.dataset.forgetProfile;
      // La valeur de retour n'était pas lue : quand la clé n'existait pas, le message annonçait une suppression
      // qui n'avait pas eu lieu et la carte restait affichée juste en dessous. Ce bouton étant le seul geste de
      // suppression de l'interface, la fiche devenait inextirpable sans que rien ne le dise.
      const archived = app.storage.forgetProfile(name);
      // Le message dit ce que le code fait vraiment. Le journal des parties appartient à toute la table : on n'en
      // retire personne, sous peine d'amputer les parties des autres joueurs. C'est la fiche qui se range, pas
      // la mémoire de la soirée — et l'ancienne vie ne se rebranche plus sur une fiche neuve du même nom.
      state.transferNotice = archived
        ? { type: "success", message: `La fiche de ${name} est archivée. Les parties déjà jouées restent au journal de la table.` }
        : { type: "error", message: `La fiche de ${name} n’a pas pu être archivée.` };
      renderProfiles();
    });
  });

  document.querySelector("[data-export-backup]")?.addEventListener("click", () => {
    downloadBackup();
    renderProfiles();
  });
  document.querySelector("[data-import-backup]")?.addEventListener("click", () => document.querySelector("[data-backup-file]")?.click());
  document.querySelector("[data-backup-file]")?.addEventListener("change", (event) => importBackupFile(event.target.files?.[0]));
  document.querySelector("[data-large-text-toggle]")?.addEventListener("change", (event) => {
    app.storage.saveSettings({ ...app.storage.loadSettings(), largeText: event.target.checked });
    document.documentElement.toggleAttribute("data-large-text", event.target.checked);
    state.transferNotice = { type: "success", message: event.target.checked ? "Affichage agrandi activé." : "Affichage standard restauré." };
    renderProfiles();
  });
  document.querySelector("[data-diagnostics-toggle]")?.addEventListener("change", (event) => {
    app.diagnostics.setEnabled(event.target.checked);
    state.transferNotice = { type: "success", message: event.target.checked ? "Journal local activé. Rien n’est envoyé sur le réseau." : "Journal local désactivé et effacé." };
    renderProfiles();
  });
  document.querySelector("[data-clear-diagnostics]")?.addEventListener("click", () => {
    app.diagnostics.clear();
    state.transferNotice = { type: "success", message: "Journal local effacé." };
    renderProfiles();
  });
}
