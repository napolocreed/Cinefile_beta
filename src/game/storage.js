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
  };
}

// Old saves predate every counter added since, so a profile read from disk is completed rather than trusted.
export function completeProfile(profile, name = profile?.name) {
  const complete = { ...blankProfile(name), ...(profile ?? {}) };
  complete.name = String(name ?? profile?.name ?? "").trim() || complete.name;
  complete.achievements = Array.isArray(complete.achievements) ? complete.achievements : [];
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
    rememberProfile: (name) => {
      const clean = String(name ?? "").trim();
      const key = profileKey(clean);
      if (!key) return null;
      const profiles = safeRead(storage, STORAGE_KEYS.profiles, {});
      // An existing profile keeps its own spelling: "alice" typed today must not rewrite "Alice" and its history.
      const profile = profiles[key] ? completeProfile(profiles[key]) : blankProfile(clean);
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

export function recordFinishedGame(game, storageApi) {
  if (!game || game.status !== "finished") return { profiles: storageApi.loadProfiles(), newAchievements: [] };
  if (storageApi.loadApplied?.().includes(game.id)) return { profiles: storageApi.loadProfiles(), newAchievements: [] };
  const profiles = storageApi.loadProfiles();
  const winner = game.players.find((player) => player.id === game.winnerId);
  const newAchievements = new Set();

  for (const player of game.players) {
    const key = profileKey(player.name);
    const profile = completeProfile(profiles[key], player.name);
    profile.games += 1;
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
