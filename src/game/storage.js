import { achievementsFor, partieValable } from "./achievements.js";
import { buildCredits } from "./credits.js";
import { normalizeText } from "./database.js";
import { MAX_SESSION_MS } from "./statistics.js";

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

    // — La fiche complète. Chacun de ces compteurs répond à une question que les quatre premiers ne savaient pas
    //   poser : combien de fois j'ai essayé, pas seulement combien de fois j'ai réussi. Un profil ancien les
    //   reçoit à zéro par completeProfile, et se met à les remplir à sa prochaine partie.
    turnsPlayed: 0,        // tours joués, ouverture exclue — le dénominateur honnête de tout le reste
    openings: 0,           // fois où l'on a ouvert la chaîne
    links: 0,              // liaisons validées
    bluffsAttempted: 0,    // bluffs tentés — sans lui, « taux de bluff » n'existe pas
    bluffsSlipped: 0,      // bluffs passés alors que la table pouvait buzzer
    challengeChances: 0,   // tours où l'on avait le doigt sur le buzzer
    buzzStreak: 0,         // buzz justes d'affilée, série qui court d'une partie à l'autre
    timeouts: 0,           // tours perdus au chrono
    livesLost: 0,          // vies perdues
    points: 0,             // somme des scores de partie
    bestStreak: 0,         // meilleure série de liaisons de tous les temps (un max, pas une somme)
    streakRun: 0,          // entier signé : positif = victoires d'affilée, négatif = défaites d'affilée
    bestWinStreak: 0,      // la plus longue série de victoires jamais tenue
    comebacks: 0,          // victoires arrachées après trois défaites d'affilée
    flawlessWins: 0,       // parties gagnées sans perdre une vie
    rankSum: 0,            // somme des places — la place moyenne s'en déduit
    rankShareSum: 0,       // somme de (table - place) / (table - 1), 0 à 1 : comparable entre tables
    tableSeats: 0,         // somme des joueurs à table — taille moyenne de table
    voiceGames: 0,         // parties en prise vocale
    playedMs: 0,           // temps de projection cumulé, séances plafonnées
    opponents: [],         // clés des adversaires déjà croisés, plafonnées
    gamesToday: 0,         // parties du jour courant
    lastDay: null,         // le jour courant, en clé locale AAAA-MM-JJ
    firstPlayedAt: null,   // première séance
    lastPlayedAt: null,    // dernière séance réellement jouée
  };
}

// Old saves predate every counter added since, so a profile read from disk is completed rather than trusted.
export function completeProfile(profile, name = profile?.name) {
  const complete = { ...blankProfile(name), ...(profile ?? {}) };
  complete.name = String(name ?? profile?.name ?? "").trim() || complete.name;
  complete.achievements = Array.isArray(complete.achievements) ? complete.achievements : [];
  complete.opponents = Array.isArray(complete.opponents) ? complete.opponents : [];
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

// Rend le succès de l'écriture : un appelant qui grave « c'est fait » ailleurs doit pouvoir savoir si ça l'est.
function safeWrite(storage, key, value) {
  try {
    storage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Private browsing or a full storage quota should not stop a local game.
    return false;
  }
}

export function createStorage(storage = globalThis.localStorage) {
  return {
    loadCurrent: () => safeRead(storage, STORAGE_KEYS.current, null),
    saveCurrent: (game) => safeWrite(storage, STORAGE_KEYS.current, game),
    clearCurrent: () => storage?.removeItem(STORAGE_KEYS.current),
    loadHistory: () => safeRead(storage, STORAGE_KEYS.history, []),
    replaceHistory: (games) => safeWrite(storage, STORAGE_KEYS.history, Array.isArray(games) ? games.slice(0, 50) : []),
    // Sous pression de quota, la fenêtre se resserre au lieu d'abandonner : une partie qui n'entre pas aux archives
    // serait tout de même marquée traitée, et la garde d'idempotence rendrait la perte irréversible.
    appendHistory: (game) => {
      const history = [game, ...safeRead(storage, STORAGE_KEYS.history, [])];
      for (const window of [50, 25, 10, 5, 1]) {
        if (safeWrite(storage, STORAGE_KEYS.history, history.slice(0, window))) return true;
      }
      return false;
    },
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

export function recordFinishedGame(game, storageApi, { credits: providedCredits = null } = {}) {
  if (!game || game.status !== "finished") return { profiles: storageApi.loadProfiles(), newAchievements: [], archived: false };
  // Déjà enregistrée : on ne recompte rien, mais les cartons décrochés à ce moment-là restent dus à l'écran, qu'on
  // y revienne par « Revoir le générique » ou après un rechargement.
  if (storageApi.loadApplied?.().includes(game.id)) {
    return { profiles: storageApi.loadProfiles(), newAchievements: game.newAchievements ?? [], archived: true };
  }

  // L'heure de fin n'est posée que par l'écran du générique, et on peut atteindre les scores sans y passer. Sans
  // ce filet, la partie entre aux archives sans durée et toutes les moyennes de temps la perdent en silence.
  game.finishedAt ??= Date.now();

  const profiles = storageApi.loadProfiles();
  const winner = game.players.find((player) => player.id === game.winnerId);
  const newAchievements = [];

  // Le générique sait déjà dépouiller le journal — vies perdues, liaisons tenues, chronos ratés, ordre des
  // éliminations. On le lit une fois pour toute la table plutôt que de réécrire le même comptage par joueur.
  // Le rouleau doit être construit AVEC la base : c'est elle qui porte les films retrouvés aux archives en cours de
  // partie. Sans eux, les succès de filmographie ne pouvaient pas se décrocher alors que le joueur venait de les
  // voir défiler au générique. L'écran passe donc celui qu'il a déjà bâti.
  const credits = providedCredits ?? buildCredits(game);
  const seatById = new Map((credits?.cast ?? []).map((seat) => [seat.id, seat]));
  const valable = partieValable(game, credits);

  // Le classement d'une partie se lit à l'envers de l'ordre d'élimination : le dernier tombé est deuxième.
  const standing = [...(credits?.cast ?? [])].sort((left, right) =>
    (right.winner === true) - (left.winner === true) || (right.eliminatedAt ?? 0) - (left.eliminatedAt ?? 0));
  const rankById = new Map(standing.map((seat, index) => [seat.id, index + 1]));

  const seats = game.players.length;
  // Une partie laissée ouverte une nuit ne représente pas une nuit de jeu : on plafonne la séance.
  const sessionMs = Math.min(Math.max(0, (game.finishedAt ?? 0) - (game.startedAt ?? 0)), MAX_SESSION_MS);
  // Clé de jour construite à la main, sans ICU : deux appareils lisent la même chose, et le tri reste textuel.
  const day = new Date(game.startedAt ?? game.finishedAt);
  const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

  // Un seul passage sur le journal pour les trois compteurs qu'aucun agrégat existant ne porte.
  const turnsBy = new Map();
  const openingsBy = new Map();
  const chancesBy = new Map();
  const bump = (map, id) => { if (id) map.set(id, (map.get(id) ?? 0) + 1); };
  for (const turn of game.turns ?? []) {
    if (turn.opening) {
      bump(openingsBy, turn.playerId);
      continue;
    }
    bump(turnsBy, turn.playerId);
    // Une occasion de buzzer suppose qu'on ait pu buzzer. Défis coupés, le moteur désigne toujours un
    // challenger — la VAR tranche à sa place — et le compteur enflait donc d'occasions que personne n'a jamais
    // eues, ce qui écrasait la fiabilité au buzzer de qui joue sans bluff. La forme négative est voulue : une
    // sauvegarde antérieure au drapeau n'a pas de config.allowBluffChallenge, et la traiter comme « coupé »
    // effacerait des occasions bien réelles. Tout ce que createGame produit porte un booléen explicite.
    if (turn.challengerId && game.config?.allowBluffChallenge !== false) bump(chancesBy, turn.challengerId);
  }

  for (const player of game.players) {
    const key = profileKey(player.name);
    // L'orthographe sur fiche l'emporte : une partie ne renomme pas un profil ni son historique. Sans ce garde,
    // une partie restaurée où le nom a été saisi en minuscules réécrivait « Alice » en « alice ».
    const profile = completeProfile(profiles[key], profiles[key]?.name ?? player.name);
    const seat = seatById.get(player.id) ?? null;
    const rank = rankById.get(player.id) ?? seats;
    const won = winner?.id === player.id;

    profile.games += 1;
    // Aucune lecture d'horloge : on ne se sert que des tampons déjà posés sur la partie, et le tampon ne recule
    // jamais — rejouer une vieille sauvegarde ne doit pas rajeunir un profil.
    profile.lastSeenAt = Math.max(profile.lastSeenAt ?? 0, game.finishedAt ?? game.startedAt ?? 0) || profile.lastSeenAt;
    profile.filmsFound += player.filmsFound;
    profile.bluffsSucceeded += player.bluffsSucceeded;
    profile.bluffsCaught += player.bluffsCaught;
    profile.challengesMade += player.challengesMade;
    profile.challengesSuccessful += player.challengesSuccessful;

    profile.turnsPlayed += turnsBy.get(player.id) ?? 0;
    profile.openings += openingsBy.get(player.id) ?? 0;
    profile.challengeChances += chancesBy.get(player.id) ?? 0;
    profile.links += seat?.links ?? 0;
    profile.timeouts += seat?.timeouts ?? 0;
    profile.livesLost += seat?.livesLost ?? 0;
    profile.bluffsAttempted += player.bluffsAttempted;
    profile.points += player.score;
    profile.bestStreak = Math.max(profile.bestStreak, player.bestStreak);
    profile.rankSum += rank;
    profile.rankShareSum += seats > 1 ? (seats - rank) / (seats - 1) : 0;
    profile.tableSeats += seats;
    profile.voiceGames += game.config?.mode === "voice" ? 1 : 0;
    profile.playedMs += sessionMs;
    const openedAt = game.startedAt ?? game.finishedAt ?? null;
    // Le minimum, et non ??=, pour rattraper l'importation d'une sauvegarde plus ancienne que la fiche.
    if (openedAt) profile.firstPlayedAt = profile.firstPlayedAt ? Math.min(profile.firstPlayedAt, openedAt) : openedAt;
    profile.lastPlayedAt = Math.max(profile.lastPlayedAt ?? 0, game.finishedAt ?? game.startedAt ?? 0) || null;

    // Ce qui suit juge le joueur, pas la table : une partie écourtée ne doit décrocher ni série, ni exploit.
    if (valable && seat) {
      if (won && seat.capacity >= 2 && seat.livesLost === 0 && seat.links >= 6) profile.flawlessWins += 1;
      // On n'utilise pas player.bluffsSucceeded : sans défis de bluff, le moteur accepte d'office tout lien
      // invalide et le compteur gonflerait gratuitement.
      if (game.config?.allowBluffChallenge) profile.bluffsSlipped += seat.bluffsSlipped;
    }
    if (valable) {
      // Un seul entier signé porte les deux séries. L'ordre compte : la série de défaites est lue avant d'être
      // remise à zéro, sinon la remontée ne serait jamais vue.
      if (won) {
        if (profile.streakRun <= -3) profile.comebacks += 1;
        profile.streakRun = Math.max(0, profile.streakRun) + 1;
        profile.bestWinStreak = Math.max(profile.bestWinStreak, profile.streakRun);
      } else {
        profile.streakRun = Math.min(0, profile.streakRun) - 1;
      }

      // Une horloge reculée ne touche à rien : sans cette garde, changer la date de l'appareil rejouerait la
      // journée en cours et offrirait la séance triple.
      if (dayKey === profile.lastDay) profile.gamesToday += 1;
      else if (!profile.lastDay || dayKey > profile.lastDay) {
        profile.gamesToday = 1;
        profile.lastDay = dayKey;
      }

      for (const other of game.players) {
        const otherKey = profileKey(other.name);
        if (other.id !== player.id && otherKey && !profile.opponents.includes(otherKey)) profile.opponents.push(otherKey);
      }
      profile.opponents = profile.opponents.slice(-40);

      // Les scènes sont déjà dans l'ordre des actes. La série n'est pas remise à zéro entre deux parties : c'est
      // ce qui en fait une série de soirée.
      for (const scene of credits?.scenes ?? []) {
        if (!scene.challenged || scene.challengerId !== player.id) continue;
        profile.buzzStreak = scene.accepted ? 0 : profile.buzzStreak + 1;
      }
    }

    if (won) {
      profile.wins += 1;
      profile.xp += 1;
    }

    const earned = achievementsFor(game, profile, { player, credits });
    for (const id of earned) {
      if (!profile.achievements.includes(id)) {
        profile.achievements.push(id);
        // Toute la table a droit à son carton, pas seulement le vainqueur : un succès décroché en perdant est
        // souvent le plus mérité de la soirée.
        newAchievements.push({ id, playerName: profile.name });
      }
    }
    profiles[key] = profile;
  }

  storageApi.saveProfiles(profiles);
  // Les cartons voyagent avec la partie : l'écran des scores se revisite, et il les doit encore.
  game.newAchievements = newAchievements;
  const archived = storageApi.appendHistory(game) !== false;
  // Ne graver « partie traitée » que si elle est effectivement aux archives : sinon la garde d'idempotence
  // interdirait tout nouvel essai et la partie disparaîtrait sans le moindre signal.
  if (archived) storageApi.markApplied?.(game.id);
  return { profiles, newAchievements, archived };
}
