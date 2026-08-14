// The studio archives. The full trophy cabinet used to unfurl on every visit and cost most of the scroll; it is
// folded away now, while the tools that people actually come here for stay in the open.

import { ACHIEVEMENTS, levelForXp } from "../../game/achievements.js";
import { CATALOG_CACHE_KEY, VERIFICATION_CACHE_KEY } from "../../game/catalog.js";
import { backupFilename, createBackup, parseBackup, restoreBackup } from "../../game/transfer.js";
import { app, assetUrl, state } from "../runtime.js";
import { escapeHtml } from "../format.js";
import { shell } from "../shell.js";

export function renderProfiles() {
  const profiles = Object.values(app.storage.loadProfiles()).sort((left, right) => right.wins - left.wins || right.xp - left.xp || (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0));
  const diagnosticEntries = app.diagnostics.load();

  app.root.innerHTML = shell(`<section class="profiles-page">
    <h1 class="marquee">Profils</h1>
    ${state.transferNotice ? `<p class="transfer-notice ${state.transferNotice.type === "error" ? "transfer-notice--error" : ""}" role="status">${escapeHtml(state.transferNotice.message)}</p>` : ""}

    ${profiles.length ? `<div class="profile-list">${profiles.map((profile) => `<article class="profile-card">
      <div class="profile-card__head"><div><h2>${escapeHtml(profile.name)}</h2><p>${escapeHtml(levelForXp(profile.xp))} · ${profile.xp} XP</p></div>${profile.games ? `<span>${profile.games} partie${profile.games > 1 ? "s" : ""}</span>` : `<span class="stamp stamp--vert">Jamais tourné</span>`}</div>
      <div class="profile-stats"><div><b>${profile.wins}</b><small>Victoires</small></div><div><b>${profile.filmsFound}</b><small>Films</small></div><div><b>${profile.bluffsSucceeded}</b><small>Bluffs</small></div><div><b>${profile.bluffsCaught}</b><small>Démasqués</small></div></div>
      ${profile.achievements?.length ? `<div class="profile-achievements">${profile.achievements.map((id) => {
        const achievement = ACHIEVEMENTS.find((item) => item.id === id);
        return achievement ? `<span title="${escapeHtml(achievement.description)}">${achievement.icon} ${escapeHtml(achievement.label)}</span>` : "";
      }).join("")}</div>` : ""}
      <button class="button button--text profile-card__forget" data-forget-profile="${escapeHtml(profile.name)}">Oublier ce profil</button>
    </article>`).join("")}</div>` : `<div class="empty-state empty-state--panel">
      <span class="stamp stamp--ambre">Pas encore de générique</span>
      <p class="prose">Ajoutez un nom au casting, ou terminez une partie, pour créer le premier profil.</p>
    </div>`}

    <details class="fold">
      <summary>Tous les succès</summary>
      <div class="fold__body">
        <div class="achievement-grid">${ACHIEVEMENTS.map((achievement) => `<div class="achievement"><span aria-hidden="true">${achievement.icon}</span><div><b>${escapeHtml(achievement.label)}</b><small>${escapeHtml(achievement.description)}</small></div></div>`).join("")}</div>
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
  // Une suppression ne doit jamais partir au premier tap, et le dépôt n'a pas de modale : le bouton demande
  // confirmation en devenant lui-même la confirmation, et se rétracte si le doigt part ailleurs.
  document.querySelectorAll("[data-forget-profile]").forEach((button) => {
    const settle = () => {
      button.textContent = "Oublier ce profil";
      button.classList.remove("button--armed");
      delete button.dataset.armed;
    };
    button.addEventListener("blur", settle);
    button.addEventListener("click", () => {
      if (!button.dataset.armed) {
        button.dataset.armed = "true";
        button.textContent = "Confirmer l’oubli ?";
        button.classList.add("button--armed");
        return;
      }
      const name = button.dataset.forgetProfile;
      app.storage.forgetProfile(name);
      state.transferNotice = { type: "success", message: `${name} n’est plus dans les archives.` };
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
