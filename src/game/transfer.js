import { GAME_VERSION } from "./engine.js";
import { completeProfile } from "./storage.js";

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const passes = (check) => { try { check(); return true; } catch { return false; } };

export const BACKUP_FORMAT = "cinefil-backup";
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 12 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateGame(game, { allowNull = false } = {}) {
  if (allowNull && game === null) return;
  assert(game && typeof game === "object", "Sauvegarde de partie invalide.");
  assert(typeof game.id === "string" && game.id.length > 0, "Identifiant de partie manquant.");
  assert(Array.isArray(game.players) && game.players.length >= 2 && game.players.length <= 10, "Nombre de joueurs invalide.");
  assert(game.players.every((player) => typeof player.id === "string" && typeof player.name === "string" && Number.isFinite(Number(player.lives))), "Joueurs invalides.");
  assert(Array.isArray(game.chain) && game.chain.every((actor) => typeof actor === "string"), "Chaîne invalide.");
  assert(Array.isArray(game.turns), "Historique des tours invalide.");
  assert(["in-progress", "finished"].includes(game.status), "État de partie invalide.");
}

function isBoundedText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isSafeExternalIds(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 10) return false;
  return Object.entries(value).every(([key, id]) => /^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(key)
    && ((typeof id === "string" && id.length <= 100) || (typeof id === "number" && Number.isFinite(id))));
}

function isSafeVerifiedPerson(person) {
  return person && typeof person === "object" && !Array.isArray(person)
    && isBoundedText(person.name, 100)
    && (person.id === undefined || person.id === null || isBoundedText(person.id, 128))
    && isSafeExternalIds(person.externalIds);
}

function isSafeVerifiedFilm(film) {
  return film && typeof film === "object" && !Array.isArray(film)
    && isBoundedText(film.title, 200)
    && (film.year === undefined || film.year === null || (Number.isInteger(film.year) && film.year >= 1800 && film.year <= 2200))
    && isSafeExternalIds(film.externalIds);
}

function isSafeVerificationCache(cache) {
  return cache?.version === 1 && Array.isArray(cache.links) && cache.links.length <= 200
    && cache.links.every((link) => link && typeof link === "object" && !Array.isArray(link)
      && isSafeVerifiedPerson(link.left) && isSafeVerifiedPerson(link.right)
      && Array.isArray(link.films) && link.films.length >= 1 && link.films.length <= 20
      && link.films.every(isSafeVerifiedFilm));
}

export function createBackup(storageApi, { catalogCache = null, verificationCache = null, appVersion = GAME_VERSION, now = Date.now } = {}) {
  // L'export est un filet de sécurité : il ne doit pas se refuser en bloc parce que le stockage contient une
  // entrée abîmée — c'est précisément la situation où il sert. Il soumettait pourtant ses propres données au
  // validateur d'import, si bien qu'une seule partie sans chaîne, ou un cache corrompu, faisait échouer le
  // téléchargement entier, sans fichier ni message. On écarte donc ce qui ne passe pas et on exporte le reste ;
  // la sévérité reste entière à l'import, où elle protège de l'extérieur.
  const current = storageApi.loadCurrent();
  const history = (storageApi.loadHistory() ?? []).filter((game) => passes(() => validateGame(game))).slice(0, 50);
  const profiles = Object.fromEntries(
    Object.entries(storageApi.loadProfiles() ?? {}).filter(([key, profile]) => key && isPlainObject(profile)),
  );
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date(now()).toISOString(),
    data: {
      current: passes(() => validateGame(current, { allowNull: true })) ? current : null,
      history,
      profiles,
      applied: (storageApi.loadApplied() ?? []).filter((id) => typeof id === "string"),
      settings: storageApi.loadSettings?.() ?? {},
      catalogCache: catalogCache?.version === 1 && Array.isArray(catalogCache.people) ? catalogCache : null,
      verificationCache: isSafeVerificationCache(verificationCache) ? verificationCache : null,
    },
  };
}

export function validateBackup(backup) {
  assert(backup && typeof backup === "object", "Fichier de sauvegarde illisible.");
  assert(backup.format === BACKUP_FORMAT, "Ce fichier n’est pas une sauvegarde Ciné-Fil.");
  assert(backup.version === BACKUP_VERSION, "Version de sauvegarde non prise en charge.");
  assert(backup.data && typeof backup.data === "object", "Contenu de sauvegarde manquant.");
  validateGame(backup.data.current, { allowNull: true });
  assert(Array.isArray(backup.data.history) && backup.data.history.length <= 50, "Historique de sauvegarde invalide.");
  for (const game of backup.data.history) validateGame(game);
  assert(isPlainObject(backup.data.profiles), "Profils invalides.");
  // Le contenu de la table n'était pas regardé : n'importe quelle valeur pouvait se trouver derrière une clé. Le
  // tri de l'écran Profils lit `.wins` sans garde, et le rendu se fait hors du try/catch de l'import — l'écran
  // cessait de se repeindre, et comme c'est lui qui porte le bouton Importer, il ne restait plus aucun moyen de
  // réimporter une sauvegarde saine.
  for (const [key, profile] of Object.entries(backup.data.profiles)) {
    assert(typeof key === "string" && key.length > 0, "Clé de profil invalide.");
    assert(isPlainObject(profile), "Profil invalide.");
  }
  assert(Array.isArray(backup.data.applied) && backup.data.applied.every((id) => typeof id === "string"), "Index des parties invalide.");
  assert(!backup.data.catalogCache || (backup.data.catalogCache.version === 1 && Array.isArray(backup.data.catalogCache.people)), "Cache cinéma invalide.");
  assert(!backup.data.verificationCache || isSafeVerificationCache(backup.data.verificationCache), "Cache de vérification invalide.");
  return backup;
}

export function parseBackup(raw, { maxBytes = MAX_BACKUP_BYTES } = {}) {
  const text = String(raw ?? "");
  assert(new TextEncoder().encode(text).byteLength <= maxBytes, "Cette sauvegarde est trop volumineuse.");
  try {
    return validateBackup(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Le fichier JSON est corrompu.");
    throw error;
  }
}

export function restoreBackup(backup, storageApi, { storage = globalThis.localStorage, catalogCacheKey = "cinefil.catalog-cache.v1", verificationCacheKey = "cinefil.verification-cache.v1" } = {}) {
  validateBackup(backup);
  // Tout ou rien. L'écriture détruisait les profils et l'historique locaux avant de buter sur le quota du cache,
  // et les deux régimes étaient incompatibles : safeWrite avale l'erreur, les setItem de cache la laissaient
  // remonter. L'utilisateur voyait donc une exception — et croyait l'import annulé — sur une base déjà écrasée,
  // ou un compte rendu triomphal sur une base restée vide, puisque le rapport décrivait le fichier et non ce qui
  // avait été écrit. On garde de quoi remettre l'existant, et on relit la base pour dire ce qui s'y trouve.
  const cacheOf = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const writeCache = (key, value) => {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };
  const previous = {
    current: storageApi.loadCurrent(),
    history: storageApi.loadHistory(),
    profiles: storageApi.loadProfiles(),
    applied: storageApi.loadApplied(),
    settings: storageApi.loadSettings?.() ?? {},
    catalogCache: cacheOf(catalogCacheKey),
    verificationCache: cacheOf(verificationCacheKey),
  };
  const restore = (data, { complete = false } = {}) => {
    const profiles = complete
      ? Object.fromEntries(Object.entries(data.profiles ?? {}).map(([key, profile]) => [key, completeProfile(profile)]))
      : data.profiles ?? {};
    const written = [
      data.current ? storageApi.saveCurrent(data.current) : (storageApi.clearCurrent(), true),
      storageApi.replaceHistory(data.history ?? []),
      storageApi.saveProfiles(profiles),
      storageApi.replaceApplied(data.applied ?? []),
      storageApi.saveSettings?.(data.settings ?? {}) ?? true,
      writeCache(catalogCacheKey, data.catalogCache ?? null),
      writeCache(verificationCacheKey, data.verificationCache ?? null),
    ];
    return written.every((result) => result !== false);
  };

  // Les fiches passent par completeProfile plutôt que d'être écrites brutes : c'est ce qui garantit que l'écran
  // Profils trouvera les compteurs qu'il lit, quelle que soit l'ancienneté de la sauvegarde.
  if (!restore(backup.data, { complete: true })) {
    restore(previous);
    throw new Error("L’espace de stockage est insuffisant : la sauvegarde précédente a été remise en place.");
  }

  const profiles = storageApi.loadProfiles();
  const history = storageApi.loadHistory();
  return {
    current: storageApi.loadCurrent(),
    games: history.length,
    profiles: Object.keys(profiles).length,
    catalogPeople: backup.data.catalogCache?.people?.length ?? 0,
    verifiedLinks: backup.data.verificationCache?.links?.length ?? 0,
  };
}

export function backupFilename(date = new Date()) {
  return `cinefil-sauvegarde-${date.toISOString().slice(0, 10)}.json`;
}
