import { GAME_VERSION } from "./engine.js";

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
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date(now()).toISOString(),
    data: {
      current: storageApi.loadCurrent(),
      history: storageApi.loadHistory(),
      profiles: storageApi.loadProfiles(),
      applied: storageApi.loadApplied(),
      settings: storageApi.loadSettings?.() ?? {},
      catalogCache,
      verificationCache,
    },
  };
  validateBackup(backup);
  return backup;
}

export function validateBackup(backup) {
  assert(backup && typeof backup === "object", "Fichier de sauvegarde illisible.");
  assert(backup.format === BACKUP_FORMAT, "Ce fichier n’est pas une sauvegarde Ciné-Fil.");
  assert(backup.version === BACKUP_VERSION, "Version de sauvegarde non prise en charge.");
  assert(backup.data && typeof backup.data === "object", "Contenu de sauvegarde manquant.");
  validateGame(backup.data.current, { allowNull: true });
  assert(Array.isArray(backup.data.history) && backup.data.history.length <= 50, "Historique de sauvegarde invalide.");
  for (const game of backup.data.history) validateGame(game);
  assert(backup.data.profiles && typeof backup.data.profiles === "object" && !Array.isArray(backup.data.profiles), "Profils invalides.");
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
  if (backup.data.current) storageApi.saveCurrent(backup.data.current);
  else storageApi.clearCurrent();
  storageApi.replaceHistory(backup.data.history);
  storageApi.saveProfiles(backup.data.profiles);
  storageApi.replaceApplied(backup.data.applied);
  storageApi.saveSettings?.(backup.data.settings ?? {});
  if (backup.data.catalogCache) storage?.setItem(catalogCacheKey, JSON.stringify(backup.data.catalogCache));
  if (backup.data.verificationCache) storage?.setItem(verificationCacheKey, JSON.stringify(backup.data.verificationCache));
  return {
    current: backup.data.current,
    games: backup.data.history.length,
    profiles: Object.keys(backup.data.profiles).length,
    catalogPeople: backup.data.catalogCache?.people?.length ?? 0,
    verifiedLinks: backup.data.verificationCache?.links?.length ?? 0,
  };
}

export function backupFilename(date = new Date()) {
  return `cinefil-sauvegarde-${date.toISOString().slice(0, 10)}.json`;
}
