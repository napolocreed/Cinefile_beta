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

export function createBackup(storageApi, { catalogCache = null, appVersion = GAME_VERSION, now = Date.now } = {}) {
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

export function restoreBackup(backup, storageApi, { storage = globalThis.localStorage, catalogCacheKey = "cinefil.catalog-cache.v1" } = {}) {
  validateBackup(backup);
  if (backup.data.current) storageApi.saveCurrent(backup.data.current);
  else storageApi.clearCurrent();
  storageApi.replaceHistory(backup.data.history);
  storageApi.saveProfiles(backup.data.profiles);
  storageApi.replaceApplied(backup.data.applied);
  storageApi.saveSettings?.(backup.data.settings ?? {});
  if (backup.data.catalogCache) storage?.setItem(catalogCacheKey, JSON.stringify(backup.data.catalogCache));
  return {
    current: backup.data.current,
    games: backup.data.history.length,
    profiles: Object.keys(backup.data.profiles).length,
    catalogPeople: backup.data.catalogCache?.people?.length ?? 0,
  };
}

export function backupFilename(date = new Date()) {
  return `cinefil-sauvegarde-${date.toISOString().slice(0, 10)}.json`;
}
