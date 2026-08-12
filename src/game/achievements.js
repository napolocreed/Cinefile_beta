export const ACHIEVEMENTS = [
  { id: "first-bluff", label: "Premier bluff réussi", description: "Bluffer sans se faire attraper", icon: "🎭" },
  { id: "films-100", label: "100 films trouvés", description: "Trouver 100 films au total", icon: "🎬" },
  { id: "wins-20", label: "20 victoires", description: "Gagner 20 parties", icon: "🏆" },
  { id: "detect-50", label: "50 bluffs détectés", description: "Démasquer 50 bluffs", icon: "🔍" },
  { id: "perfect-game", label: "Sans faute", description: "Terminer une partie sans erreur", icon: "✨" },
  { id: "streak-10", label: "Série de 10", description: "10 réponses correctes d'affilée", icon: "🔥" },
];

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

export function achievementsFor(game, profile) {
  const winner = game.players.find((player) => player.id === game.winnerId);
  const perfect = winner && winner.filmsFound > 0 && game.turns.filter((turn) => turn.playerId === winner.id && !turn.wasValid).length === 0;
  return [
    profile.bluffsSucceeded >= 1 && "first-bluff",
    profile.filmsFound >= 100 && "films-100",
    profile.wins >= 20 && "wins-20",
    profile.bluffsCaught >= 50 && "detect-50",
    perfect && "perfect-game",
    game.players.some((player) => player.bestStreak >= 10) && "streak-10",
  ].filter(Boolean);
}
