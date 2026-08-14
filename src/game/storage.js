import { achievementsFor } from "./achievements.js";
import { normalizeText } from "./database.js";

// One shape for a profile, written once. A profile used to exist only as the by-product of a finished game, so
// every counter was invented on the spot inside recordFinishedGame; now that the setup screen can create one
// before it has ever played, the blank has to be a real thing rather than an implicit one.
export function blankProfile(name) {
  return {
    name: String(name ?? "").trim(),
    xp: 0,
    games: 0,
    wins: 0,
    filmsFound: 0,
    bluffsSucceeded: 0,
    bluffsCaught: 0,
    achievements: [],
    challengesMade: 0,
    challengesSuccessful: 0,
    // Le dernier soir où ce nom est monté sur une feuille de casting. C'est ce qui classe la planche de contact.
    // Une fiche restaurée d'une sauvegarde antérieure n'en a pas : elle vaut null et passe en fin de rang.
    lastSeenAt: null,
  };
}

// Old saves predate every counter added since, so a profile read from disk is completed rather than trusted.
export function completeProfile(profile, name = profile?.name) {
  const complete = { ...blankProfile(name), ...(profile ?? {}) };
  complete.name = String(name ?? profile?.name ?? "").trim() || complete.name;
  complete.achievements = Array.isArray(complete.achievements) ? complete.achievements : [];
  // Un tampon corrompu par une sauvegarde bricolée ne doit pas emporter le tri de la planche de contact.
  complete.lastSeenAt = Number.isFinite(complete.lastSeenAt) ? complete.lastSeenAt : null;
  return complete;
}

export const profileKey = (name) => normalizeText(name);

export const STORAGE_KEYS = Object.freeze({
  current: "cinelink.current.v1",
  history: "cinelink.history.v1",
  profiles: "cinelink.profiles.v1",
  applied: "cinelink.applied.v1",
  settings: "cinefil.settings.v1",
});

function safeRead(storage, key, fallback) {
  try {
    const value = storage?.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full storage quota should not stop a local game.
  }
}

export function createStorage(storage = globalThis.localStorage) {
  return {
    loadCurrent: () => safeRead(storage, STORAGE_KEYS.current, null),
    saveCurrent: (game) => safeWrite(storage, STORAGE_KEYS.current, game),
    clearCurrent: () => storage?.removeItem(STORAGE_KEYS.current),
    loadHistory: () => safeRead(storage, STORAGE_KEYS.history, []),
    replaceHistory: (games) => safeWrite(storage, STORAGE_KEYS.history, Array.isArray(games) ? games.slice(0, 50) : []),
    appendHistory: (game) => safeWrite(storage, STORAGE_KEYS.history, [game, ...safeRead(storage, STORAGE_KEYS.history, [])].slice(0, 50)),
    loadProfiles: () => safeRead(storage, STORAGE_KEYS.profiles, {}),
    saveProfiles: (profiles) => safeWrite(storage, STORAGE_KEYS.profiles, profiles),
    // A name typed at the casting call is a profile from that moment on, with nothing to its name yet. Returning
    // the profile — created or already there — is what lets the setup screen show it back immediately.
    rememberProfile: (name, { now = Date.now } = {}) => {
      const clean = String(name ?? "").trim();
      const key = profileKey(clean);
      if (!key) return null;
      const profiles = safeRead(storage, STORAGE_KEYS.profiles, {});
      // An existing profile keeps its own spelling: "alice" typed today must not rewrite "Alice" and its history.
      const profile = profiles[key] ? completeProfile(profiles[key]) : blankProfile(clean);
      profile.lastSeenAt = now();
      profiles[key] = profile;
      safeWrite(storage, STORAGE_KEYS.profiles, profiles);
      return profile;
    },
    forgetProfile: (name) => {
      const key = profileKey(name);
      if (!key) return false;
      const profiles = safeRead(storage, STORAGE_KEYS.profiles, {});
      if (!(key in profiles)) return false;
      delete profiles[key];
      safeWrite(storage, STORAGE_KEYS.profiles, profiles);
      return true;
    },
    loadApplied: () => safeRead(storage, STORAGE_KEYS.applied, []),
    markApplied: (gameId) => safeWrite(storage, STORAGE_KEYS.applied, [...new Set([gameId, ...safeRead(storage, STORAGE_KEYS.applied, [])])].slice(0, 100)),
    replaceApplied: (gameIds) => safeWrite(storage, STORAGE_KEYS.applied, [...new Set(Array.isArray(gameIds) ? gameIds : [])].slice(0, 100)),
    loadSettings: () => safeRead(storage, STORAGE_KEYS.settings, {}),
    saveSettings: (settings) => safeWrite(storage, STORAGE_KEYS.settings, settings && typeof settings === "object" ? settings : {}),
  };
}

function compareByRecency(left, right) {
  const seen = (right.profile.lastSeenAt ?? 0) - (left.profile.lastSeenAt ?? 0);
  if (seen) return seen;
  if (left.profile.games !== right.profile.games) return right.profile.games - left.profile.games;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

// La planche de contact : les profils les plus récents d'abord, coupés à `visible`. Une vignette déjà choisie ne
// remonte jamais en tête — la fenêtre s'allonge jusqu'à elle. Sans ça, chaque tap ferait valser les voisines sous
// le doigt, et le tap suivant tomberait sur le mauvais nom.
export function castingRoster(profiles, selectedKeys = [], { visible = 6 } = {}) {
  const selected = new Set((selectedKeys ?? []).filter(Boolean));
  const entries = Object.entries(profiles ?? {})
    .filter(([key, profile]) => key && profile && typeof profile === "object" && !Array.isArray(profile))
    .map(([key, profile]) => ({ key, profile: completeProfile(profile) }))
    .sort(compareByRecency);
  const deepest = entries.reduce((cut, entry, index) => (selected.has(entry.key) ? index + 1 : cut), 0);
  const cut = Math.max(visible, deepest);
  return { shown: entries.slice(0, cut), hidden: entries.slice(cut) };
}

export function recordFinishedGame(game, storageApi) {
  if (!game || game.status !== "finished") return { profiles: storageApi.loadProfiles(), newAchievements: [] };
  if (storageApi.loadApplied?.().includes(game.id)) return { profiles: storageApi.loadProfiles(), newAchievements: [] };
  const profiles = storageApi.loadProfiles();
  const winner = game.players.find((player) => player.id === game.winnerId);
  const newAchievements = new Set();

  for (const player of game.players) {
    const key = profileKey(player.name);
    // L'orthographe sur fiche l'emporte : une partie ne renomme pas un profil ni son historique. Sans ce garde,
    // une partie restaurée où le nom a été saisi en minuscules réécrivait « Alice » en « alice ».
    const profile = completeProfile(profiles[key], profiles[key]?.name ?? player.name);
    profile.games += 1;
    // Aucune lecture d'horloge : on ne se sert que des tampons déjà posés sur la partie, et le tampon ne recule
    // jamais — rejouer une vieille sauvegarde ne doit pas rajeunir un profil.
    profile.lastSeenAt = Math.max(profile.lastSeenAt ?? 0, game.finishedAt ?? game.startedAt ?? 0) || profile.lastSeenAt;
    profile.filmsFound += player.filmsFound;
    profile.bluffsSucceeded += player.bluffsSucceeded;
    profile.bluffsCaught += player.bluffsCaught;
    profile.challengesMade += player.challengesMade;
    profile.challengesSuccessful += player.challengesSuccessful;
    if (winner?.id === player.id) {
      profile.wins += 1;
      profile.xp += 1;
    }
    const earned = achievementsFor(game, profile);
    for (const id of earned) {
      if (!profile.achievements.includes(id)) {
        profile.achievements.push(id);
        if (winner?.id === player.id) newAchievements.add(id);
      }
    }
    profiles[key] = profile;
  }

  storageApi.saveProfiles(profiles);
  storageApi.appendHistory(game);
  storageApi.markApplied?.(game.id);
  return { profiles, newAchievements: [...newAchievements] };
}
