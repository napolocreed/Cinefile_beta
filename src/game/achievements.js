// Le tableau d'honneur.
//
// Six succès ne tenaient pas une rejouabilité : on les décrochait tous en trois soirées, et deux d'entre eux se
// donnaient à toute la table parce qu'ils jugeaient la partie et non le joueur. Ils sont cinquante désormais, et
// chacun se prononce sur UN joueur — d'où le `player` passé à `achievementsFor`.
//
// Tout se calcule sur ce que la partie a déjà écrit : le générique dépouille le journal (vies perdues, liaisons
// tenues, bluffs passés, ordre des éliminations) et neuf compteurs de profil portent ce qui traverse les parties.
// Rien n'est reconstruit ici deux fois, et rien ne demande le réseau.

import { buildCredits } from "./credits.js";
import { normalizeText } from "./identity.js";

export const FAMILIES = Object.freeze({
  carriere: "Carrière",
  exploit: "Exploits de partie",
  bluff: "Bluff et enquête",
  cinephilie: "Cinéphilie",
});

export const TIERS = Object.freeze({
  bronze: "Bronze",
  argent: "Argent",
  or: "Or",
  culte: "Culte",
});

export const LEVELS = [
  { min: 0, label: "Débutant" },
  { min: 5, label: "Cinéphile" },
  { min: 20, label: "Expert" },
  { min: 50, label: "Réalisateur" },
  { min: 100, label: "Légende" },
];

export function levelForXp(xp) {
  return [...LEVELS].reverse().find((level) => xp >= level.min)?.label ?? LEVELS[0].label;
}

// Une progression n'est lisible que sur une fiche : ce qui se mesure pendant une partie n'a pas de place dans un
// écran de consultation. Seuls les succès à compteur persistant en portent une.
const reach = (value, target) => ({ value: Math.max(0, Math.min(Number(value) || 0, target)), target });

// Une partie de deux tours entre deux joueurs dont l'un abandonne n'est pas une partie : sans ce garde, la moitié
// du tableau se décrocherait par accident de données.
export function partieValable(game, roll) {
  return game?.status === "finished"
    && (game.players?.length ?? 0) >= 2
    && roll.tally.acts >= 6
    && roll.tally.actors >= 6;
}

export const ACHIEVEMENTS = [
  {
    id: "carriere-premiere-seance",
    label: "Premier tour de manivelle",
    description: "Terminer sa première partie complète.",
    icon: "🎞️",
    family: "carriere",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.games >= 1,
  },
  {
    id: "carriere-premiere-victoire",
    label: "Première ovation",
    description: "Remporter sa première partie.",
    icon: "🏆",
    family: "carriere",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.wins >= 1,
  },
  {
    id: "carriere-films-50",
    label: "Cinquante titres",
    description: "Cumuler cinquante films crédités sur son profil.",
    icon: "🎬",
    family: "carriere",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.filmsFound >= 50,
    progress: (P) => reach(P.filmsFound, 50),
  },
  {
    id: "carriere-seance-triple",
    label: "Séance triple",
    description: "Terminer trois parties dans la même journée.",
    icon: "🎟️",
    family: "carriere",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.gamesToday >= 3,
    progress: (P) => reach(P.gamesToday, 3),
  },
  {
    id: "carriere-parties-25",
    label: "Vingt-cinq séances",
    description: "Terminer vingt-cinq parties.",
    icon: "📽️",
    family: "carriere",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.games >= 25,
    progress: (P) => reach(P.games, 25),
  },
  {
    id: "carriere-wins-10",
    label: "Tête d'affiche",
    description: "Remporter dix parties.",
    icon: "⭐",
    family: "carriere",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.wins >= 10,
    progress: (P) => reach(P.wins, 10),
  },
  {
    id: "carriere-films-250",
    label: "Le fonds d'archives",
    description: "Cumuler deux cent cinquante films crédités.",
    icon: "📼",
    family: "carriere",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.filmsFound >= 250,
    progress: (P) => reach(P.filmsFound, 250),
  },
  {
    id: "carriere-troupe-12",
    label: "Toute la troupe",
    description: "Avoir joué contre douze adversaires différents.",
    icon: "👥",
    family: "carriere",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && Array.isArray(P.opponents) && P.opponents.length >= 12,
    progress: (P) => reach(P.opponents.length, 12),
  },
  {
    id: "carriere-retour-doublure",
    label: "Le retour de la doublure",
    description: "Gagner une partie après trois défaites d'affilée.",
    icon: "🔁",
    family: "carriere",
    tier: "argent",
    secret: true,
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.comebacks >= 1,
  },
  {
    id: "carriere-parties-100",
    label: "Cent séances",
    description: "Terminer cent parties.",
    icon: "🍿",
    family: "carriere",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.games >= 100,
    progress: (P) => reach(P.games, 100),
  },
  {
    id: "carriere-wins-50",
    label: "La consécration",
    description: "Remporter cinquante parties.",
    icon: "🥇",
    family: "carriere",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.wins >= 50,
    progress: (P) => reach(P.wins, 50),
  },
  {
    id: "carriere-serie-5",
    label: "Cinq ovations d'affilée",
    description: "Remporter cinq parties consécutives.",
    icon: "🎖️",
    family: "carriere",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.streakRun >= 5,
    progress: (P) => reach(Math.max(0, P.streakRun), 5),
  },
  {
    id: "carriere-films-1000",
    label: "La cinémathèque",
    description: "Cumuler mille films crédités.",
    icon: "🏛️",
    family: "carriere",
    tier: "culte",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.filmsFound >= 1000,
    progress: (P) => reach(P.filmsFound, 1000),
  },
  {
    id: "carriere-une-annee",
    label: "Une année au générique",
    description: "Jouer encore un an après sa première partie, avec cinquante parties au compteur.",
    icon: "⏳",
    family: "carriere",
    tier: "culte",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.firstPlayedAt && P.games >= 50 && ((P.lastSeenAt ?? 0) - P.firstPlayedAt) >= 365 * 86400000,
    progress: (P) => reach(P.games >= 50 && P.firstPlayedAt ? (P.lastSeenAt ?? 0) - P.firstPlayedAt : 0, 365 * 86400000),
  },
  {
    id: "exploit-pellicule-intacte",
    label: "Pellicule intacte",
    description: "Gagner une partie sans perdre une seule vie.",
    icon: "🛡️",
    family: "exploit",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.winner && me.capacity >= 2 && me.livesLost === 0 && me.links >= 6,
  },
  {
    id: "exploit-face-a-face",
    label: "Le face-à-face",
    description: "Gagner un duel à deux joueurs en signant au moins dix liaisons.",
    icon: "⚔️",
    family: "exploit",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.mode === "classic" && game.players.length === 2 && me.winner && me.links >= 10,
  },
  {
    id: "exploit-prise-directe",
    label: "Prise directe",
    description: "Gagner une partie en mode vocal après au moins huit liaisons.",
    icon: "🎙️",
    family: "exploit",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.mode === "voice" && me.winner && me.links >= 8,
  },
  {
    id: "exploit-premier-role",
    label: "Le premier rôle",
    description: "Gagner en signant à soi seul plus de liaisons que toute la table réunie.",
    icon: "🌟",
    family: "exploit",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.players.length >= 3 && me.winner && me.links >= 6 && me.links > roll.cast.filter((c) => c.id !== me.id).reduce((sum, c) => sum + c.links, 0),
  },
  {
    id: "exploit-derniere-vie",
    label: "Sur la dernière vie",
    description: "Gagner avec une seule vie restante, à trois joueurs ou plus.",
    icon: "🕯️",
    family: "exploit",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.winner && me.capacity >= 3 && me.lives === 1 && game.players.length >= 3 && me.links >= 6,
  },
  {
    id: "exploit-grand-plateau",
    label: "Le grand plateau",
    description: "Gagner une partie lancée à six joueurs ou plus.",
    icon: "🎪",
    family: "exploit",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.winner && game.players.length >= 6 && t.acts >= 15,
  },
  {
    id: "exploit-serie-huit",
    label: "Huit maillons d'affilée",
    description: "Enchaîner huit propositions acceptées sans une seule faute.",
    icon: "🔗",
    family: "exploit",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.bestStreak >= 8,
  },
  {
    id: "exploit-dix-secondes",
    label: "Dix secondes, pas plus",
    description: "Gagner une partie réglée à dix secondes par tour sans jamais laisser filer le chrono.",
    icon: "⏱️",
    family: "exploit",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.turnSeconds > 0 && game.config.turnSeconds <= 10 && me.winner && me.timeouts === 0 && me.links >= 10,
  },
  {
    id: "exploit-prise-unique",
    label: "Prise unique",
    description: "Gagner une partie à une seule vie par joueur, à trois joueurs ou plus.",
    icon: "🎯",
    family: "exploit",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.livesPerPlayer === 1 && game.players.length >= 3 && me.winner && me.links >= 6,
  },
  {
    id: "exploit-cinq-sans-rayure",
    label: "Cinq fois sans rayure",
    description: "Remporter cinq parties sans y perdre la moindre vie.",
    icon: "🏅",
    family: "exploit",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => P.flawlessWins >= 5,
    progress: (P) => reach(P.flawlessWins, 5),
  },
  {
    id: "exploit-copie-zero",
    label: "Copie zéro",
    description: "Gagner à quatre joueurs ou plus avec quinze liaisons, sans perdre une vie ni proposer une seule liaison douteuse.",
    icon: "💠",
    family: "exploit",
    tier: "culte",
    secret: true,
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.winner && me.capacity >= 2 && game.players.length >= 4 && me.livesLost === 0 && me.bluffsAttempted === 0 && me.links >= 15,
  },
  {
    id: "exploit-dans-la-boite",
    label: "C'est dans la boîte",
    description: "Gagner en ayant soi-même sorti chacun de ses adversaires.",
    icon: "📦",
    family: "exploit",
    tier: "culte",
    secret: true,
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.winner && game.players.length >= 3 && t.acts >= 10 && S.filter((s) => s.eliminated && s.struckId !== player.id && (s.challengerId === player.id || s.playerId === player.id)).length === game.players.length - 1,
  },
  {
    id: "bluff-premier-trucage",
    label: "Cascade non créditée",
    description: "Faire passer un premier bluff alors que la table pouvait buzzer.",
    icon: "🎭",
    family: "bluff",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => P.bluffsSlipped >= 1,
  },
  {
    id: "bluff-buzz-premier",
    label: "Coupez !",
    description: "Démasquer un premier bluff au buzz.",
    icon: "✂️",
    family: "bluff",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.challengesSuccessful >= 1,
  },
  {
    id: "bluff-passage-var",
    label: "Passage à la VAR",
    description: "Gagner un buzz tranché à la main par la table.",
    icon: "⚖️",
    family: "bluff",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && S.some((s) => s.manual && s.challenged && s.challengerId === player.id && !s.accepted),
  },
  {
    id: "bluff-derniere-bobine",
    label: "Sur la dernière bobine",
    description: "Faire passer un bluff alors qu'il ne restait qu'une seule vie.",
    icon: "🧗",
    family: "bluff",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.allowBluffChallenge === true && me.capacity >= 2 && S.some((s) => s.kind === "bluff-slipped" && s.playerId === player.id && me.capacity - S.filter((p) => p.act < s.act && p.struckId === player.id).length === 1),
  },
  {
    id: "bluff-trucage-invisible",
    label: "Le trucage invisible",
    description: "Gagner après avoir fait passer trois bluffs sans jamais être démasqué.",
    icon: "🎩",
    family: "bluff",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.allowBluffChallenge === true && game.players.length >= 3 && me.winner && me.bluffsSlipped >= 3 && me.bluffsUnmasked === 0 && t.acts >= 12,
  },
  {
    id: "bluff-scripte",
    label: "Scripte irréprochable",
    description: "Boucler une partie avec au moins trois buzz, tous justes.",
    icon: "📋",
    family: "bluff",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && t.acts >= 8 && me.challengesMade >= 3 && me.challengesLost === 0,
  },
  {
    id: "bluff-vainqueur-en-faute",
    label: "Le vainqueur pris en faute",
    description: "Démasquer un bluff du joueur qui remportera la partie.",
    icon: "🕵️",
    family: "bluff",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && Boolean(game.winnerId) && t.acts >= 8 && roll.bluffs.unmasked.some((s) => s.challengerId === player.id && s.playerId === game.winnerId),
  },
  {
    id: "bluff-vingt-cinq",
    label: "Le truquiste maison",
    description: "Faire passer vingt-cinq bluffs, tous cumuls confondus.",
    icon: "🃏",
    family: "bluff",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => P.bluffsSlipped >= 25,
    progress: (P) => reach(P.bluffsSlipped, 25),
  },
  {
    id: "bluff-oeil-monteur",
    label: "Œil de monteur",
    description: "Enchaîner cinq buzz justes d'affilée, série qui court d'une partie à l'autre.",
    icon: "👁️",
    family: "bluff",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => P.buzzStreak >= 5,
    progress: (P) => reach(P.buzzStreak, 5),
  },
  {
    id: "bluff-dernier-plan",
    label: "Dernier plan truqué",
    description: "Gagner une partie dont le dernier maillon de la chaîne était son propre bluff.",
    icon: "🪄",
    family: "bluff",
    tier: "or",
    secret: true,
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.allowBluffChallenge === true && t.acts >= 10 && me.winner && R.at(-1)?.bluff === true && R.at(-1)?.playerId === player.id,
  },
  {
    id: "bluff-transparence",
    label: "Transparence totale",
    description: "Gagner une partie de quinze actes avec cinq bluffs passés et aucun démasqué.",
    icon: "🪞",
    family: "bluff",
    tier: "culte",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && game.config?.allowBluffChallenge === true && t.acts >= 15 && me.winner && me.bluffsSlipped >= 5 && me.bluffsUnmasked === 0,
  },
  {
    id: "bluff-trente-sans-bavure",
    label: "Trente buzz sans bavure",
    description: "Avoir buzzé trente fois depuis le premier jour sans une seule fausse alerte.",
    icon: "🧿",
    family: "bluff",
    tier: "culte",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && P.challengesMade >= 30 && P.challengesSuccessful === P.challengesMade,
    progress: (P) => reach(P.challengesSuccessful === P.challengesMade ? P.challengesMade : 0, 30),
  },
  {
    id: "cine-duo-recurrent",
    label: "Le duo récurrent",
    description: "Poser une liaison appuyée sur au moins cinq films communs.",
    icon: "👯",
    family: "cinephilie",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && R.some((e) => e.playerId === player.id && e.from && !e.bluff && e.films.length >= 5),
  },
  {
    id: "cine-court-metrage",
    label: "Court métrage",
    description: "Boucler une chaîne de douze acteurs en moins de quatre minutes.",
    icon: "⏩",
    family: "cinephilie",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && roll.durationMs !== null && roll.durationMs <= 240000 && t.actors >= 12 && me.links >= 3,
  },
  {
    id: "cine-seance-minuit",
    label: "La séance de minuit",
    description: "Terminer une partie de douze acteurs entre minuit et cinq heures du matin.",
    icon: "🌙",
    family: "cinephilie",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && Boolean(game.finishedAt) && new Date(game.finishedAt).getHours() < 5 && t.actors >= 12 && me.links >= 3,
  },
  {
    id: "cine-premier-plan",
    label: "Le premier plan",
    description: "Ouvrir la chaîne et remporter la partie.",
    icon: "🎦",
    family: "cinephilie",
    tier: "bronze",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && S[0]?.kind === "opening" && S[0]?.playerId === player.id && me.winner && t.actors >= 12,
  },
  {
    id: "cine-bobine-vingt",
    label: "La bobine de vingt",
    description: "Terminer une partie dont la chaîne atteint vingt acteurs.",
    icon: "🌀",
    family: "cinephilie",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && t.actors >= 20 && me.links >= 3,
  },
  {
    id: "cine-sans-doublure",
    label: "Sans doublure",
    description: "Signer huit liaisons dans une partie sans une seule liaison refusée ni un temps mort.",
    icon: "🧵",
    family: "cinephilie",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.links >= 8 && me.bluffsAttempted === 0,
  },
  {
    id: "cine-archiviste",
    label: "L'archiviste",
    description: "Créditer vingt films dans une seule partie.",
    icon: "🗃️",
    family: "cinephilie",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && me.filmsFound >= 20 && me.links >= 8,
  },
  {
    id: "cine-film-fleuve",
    label: "Le film-fleuve",
    description: "Tenir une partie de plus de quarante-cinq minutes et vingt-cinq acteurs.",
    icon: "⌛",
    family: "cinephilie",
    tier: "argent",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && roll.durationMs !== null && roll.durationMs >= 2700000 && t.actors >= 25 && me.links >= 5,
  },
  {
    id: "cine-repechage",
    label: "Repêchage au montage",
    description: "Reprendre un nom recalé plus tôt dans la partie et le faire tenir.",
    icon: "♻️",
    family: "cinephilie",
    tier: "argent",
    secret: true,
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && t.actors >= 12 && R.some((e) => e.playerId === player.id && e.from && roll.guests.some((g) => g.act < e.act && normalizeText(g.name) === normalizeText(e.actor))),
  },
  {
    id: "cine-copie-neuve",
    label: "Copie neuve",
    description: "Traverser une partie de quinze acteurs sans un seul bluff ni temps mort à toute la table.",
    icon: "✨",
    family: "cinephilie",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && t.actors >= 15 && t.bluffsAttempted === 0 && me.links >= 3,
  },
  {
    id: "cine-duo-mythique",
    label: "Le duo mythique",
    description: "Poser une liaison appuyée sur au moins dix films communs.",
    icon: "💞",
    family: "cinephilie",
    tier: "or",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && R.some((e) => e.playerId === player.id && e.from && !e.bluff && e.films.length >= 10),
  },
  {
    id: "cine-plan-sequence",
    label: "Le plan-séquence",
    description: "Terminer une partie dont la chaîne atteint quarante-cinq acteurs, en y signant dix liaisons.",
    icon: "🎥",
    family: "cinephilie",
    tier: "culte",
    earn: ({ valable, game, player, roll, me, t, S, R, P }) => valable && me && t.actors >= 45 && me.links >= 10,
  },
];

const BY_ID = new Map(ACHIEVEMENTS.map((achievement) => [achievement.id, achievement]));
export const achievementById = (id) => BY_ID.get(id) ?? null;

// Les succès d'un joueur, pour une partie terminée. `credits` est passé quand l'appelant l'a déjà construit —
// recordFinishedGame le fait une fois pour toute la table plutôt qu'une fois par joueur.
export function achievementsFor(game, profile, { player = null, credits = null } = {}) {
  if (!game || !profile) return [];
  const roll = credits ?? buildCredits(game);
  if (!roll) return [];
  const context = {
    game,
    player,
    roll,
    me: player ? roll.cast.find((seat) => seat.id === player.id) ?? null : null,
    t: roll.tally,
    S: roll.scenes,
    R: roll.reel,
    P: profile,
    valable: partieValable(game, roll),
  };
  const earned = [];
  for (const achievement of ACHIEVEMENTS) {
    try {
      if (achievement.earn(context)) earned.push(achievement.id);
    } catch {
      // Une fiche d'une version antérieure peut manquer un compteur : un succès illisible n'en décroche aucun
      // autre avec lui.
    }
  }
  return earned;
}

// Ce qu'il reste à faire, pour les succès dont la progression se lit sur la fiche seule.
export function progressFor(achievement, profile) {
  if (!achievement?.progress || !profile) return null;
  try {
    const progress = achievement.progress(profile);
    return progress && progress.target > 0 ? progress : null;
  } catch {
    return null;
  }
}
