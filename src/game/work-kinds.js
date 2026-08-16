// Ce qui compte comme un film, décidé à un seul endroit.
//
// La détection de films communs a longtemps posé une seule question — « est-ce que TMDb appelle ça un movie ? » —
// et TMDb appelle « movie » un documentaire d'archives, un making-of, une captation de plateau et une cérémonie.
// Deux acteurs passés vingt ans plus tard sur le même canapé de télévision se retrouvaient donc « liés par un
// film ». Le type ne suffit pas : il faut une nature, et une nature qui survive au stockage.
//
// Quatre natures, et un aveu d'ignorance. L'aveu compte autant que le reste : un catalogue publié avant cette
// version ne porte aucun genre, et refuser tout ce qu'on ne sait pas classer viderait le jeu de ses films plutôt
// que de ses émissions. UNKNOWN joue donc avec le cinéma, jusqu'à ce que l'enrichissement le nomme.

export const WORK_KINDS = Object.freeze({
  CINEMA: "cinema",
  DOCUMENTARY: "documentary",
  SERIES: "series",
  SHOW: "show",
  UNKNOWN: "unknown",
});

const KIND_VALUES = new Set(Object.values(WORK_KINDS));

// Le socle, toujours joué : le cinéma de fiction, et ce qu'on n'a pas encore su nommer.
export const CORE_KINDS = Object.freeze([WORK_KINDS.CINEMA, WORK_KINDS.UNKNOWN]);
export const CORE_SCOPE = Object.freeze(new Set(CORE_KINDS));

// Les extensions, dans l'ordre où l'écran de mise en place les présente. Chacune ouvre exactement une nature :
// c'est ce qui permet de jouer les séries sans rouvrir la porte aux talk-shows, qui est le cas d'usage qui a
// coûté une vie à un joueur qui criait pourtant juste.
export const WORK_EXTENSIONS = Object.freeze([
  Object.freeze({
    id: "documentaries",
    kind: WORK_KINDS.DOCUMENTARY,
    label: "Documentaires",
    hint: "Portraits, films d’archives, making-of",
  }),
  Object.freeze({
    id: "series",
    kind: WORK_KINDS.SERIES,
    label: "Séries & téléfilms",
    hint: "Fiction télévisée, mini-séries",
  }),
  Object.freeze({
    id: "shows",
    kind: WORK_KINDS.SHOW,
    label: "Émissions & plateaux",
    hint: "Talk-shows, jeux, cérémonies",
  }),
]);

export const DEFAULT_EXTENSIONS = Object.freeze(Object.fromEntries(WORK_EXTENSIONS.map((extension) => [extension.id, false])));

// Une sauvegarde antérieure aux extensions n'en porte aucune, et une config bricolée peut en porter n'importe
// quoi : dans les deux cas la table joue le périmètre par défaut plutôt qu'un périmètre indéfini.
export function normalizeExtensions(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze(Object.fromEntries(WORK_EXTENSIONS.map((extension) => [extension.id, source[extension.id] === true])));
}

export function scopeFromExtensions(extensions) {
  const active = normalizeExtensions(extensions);
  return new Set([...CORE_KINDS, ...WORK_EXTENSIONS.filter((extension) => active[extension.id]).map((extension) => extension.kind)]);
}

// Ce que le périmètre autorise, dit en français, pour l'écran et pour le générique.
export function describeExtensions(extensions) {
  const active = normalizeExtensions(extensions);
  return WORK_EXTENSIONS.filter((extension) => active[extension.id]).map((extension) => extension.label);
}

export function isKnownKind(value) {
  return typeof value === "string" && KIND_VALUES.has(value);
}

/* -----------------------------------------------------------------------------
   Classer une œuvre
   -------------------------------------------------------------------------- */

// Les genres TMDb, ceux qui changent la nature d'une œuvre. Les autres — comédie, drame, thriller — ne disent
// rien du support et ne sont donc pas listés.
const TMDB_DOCUMENTARY = 99;
const TMDB_TV_MOVIE = 10770;
const TMDB_SHOW_GENRES = new Set([
  10763, // Actualités
  10764, // Réalité
  10767, // Talk
]);

function genreList(value) {
  return (Array.isArray(value) ? value : []).map(Number).filter(Number.isFinite);
}

// Le classement d'un crédit TMDb, à partir de ce que l'API donne dans la filmographie combinée : le support et
// les genres. Sans genres — un catalogue publié avant cette version — on ne devine pas, on l'avoue.
export function classifyTmdbCredit({ mediaType, genreIds } = {}) {
  const genres = genreList(genreIds);
  const television = mediaType === "tv";
  if (!genres.length) return television ? WORK_KINDS.SERIES : WORK_KINDS.UNKNOWN;
  if (television) {
    // L'ordre compte : une émission d'archives se réclame souvent aussi du documentaire, et c'est bien sur le
    // plateau qu'elle a réuni ses invités.
    if (genres.some((genre) => TMDB_SHOW_GENRES.has(genre))) return WORK_KINDS.SHOW;
    if (genres.includes(TMDB_DOCUMENTARY)) return WORK_KINDS.DOCUMENTARY;
    return WORK_KINDS.SERIES;
  }
  if (genres.includes(TMDB_DOCUMENTARY)) return WORK_KINDS.DOCUMENTARY;
  // « Téléfilm » chez TMDb couvre aussi bien le film de télévision que la captation d'une soirée spéciale. Il
  // n'est jamais sorti en salle : il appartient à l'extension télévision, pas au socle.
  if (genres.includes(TMDB_TV_MOVIE)) return WORK_KINDS.SERIES;
  return WORK_KINDS.CINEMA;
}

// Wikidata range le film documentaire et le téléfilm sous « film » (Q11424) par héritage de sous-classes : la
// requête les trouve donc forcément, et c'est à la lecture qu'on les sépare.
export function classifyWikidataFilm({ documentary = false, television = false } = {}) {
  if (television) return WORK_KINDS.SERIES;
  if (documentary) return WORK_KINDS.DOCUMENTARY;
  return WORK_KINDS.CINEMA;
}

// Les catégories d'une page Wikipédia, en français comme en anglais. C'est une source d'indices, jamais de
// preuve : elle ne sert qu'à écarter une page dont la catégorie dit franchement autre chose qu'un film.
// `\b` est ASCII : il ne se déclenche ni devant ni derrière une lettre accentuée. L'alternative « émission » ne
// pouvait donc matcher que l'orthographe sans accent, celle que Wikipédia n'écrit jamais, et « Film télévisé
// américain » ressortait en cinéma — le cas exact que la branche existe pour rejeter. Les gardes Unicode
// remplacent les deux.
const EDGE_BEFORE = "(?<![\\p{L}\\p{N}])";
const EDGE_AFTER = "(?![\\p{L}\\p{N}])";
const WIKIPEDIA_DOCUMENTARY = new RegExp(`${EDGE_BEFORE}(documentaire|documentary|docufiction)${EDGE_AFTER}`, "iu");
const WIKIPEDIA_TELEVISION = new RegExp(
  `${EDGE_BEFORE}(t[ée]l[ée]vis(?:ion|ée|é|ed)|t[ée]l[ée]film|s[ée]rie|series|sitcom|feuilleton|[ée]mission|talk[- ]show|television)${EDGE_AFTER}`,
  "iu",
);
// « Film de la série Saw », « Film de la série James Bond », « American film series » : ici « série » désigne une
// franchise de cinéma, pas un feuilleton. Sans cette réserve, de vrais films perdaient leur indice Wikipédia et
// leur verdict PROBABLE retombait en NOT_FOUND.
const WIKIPEDIA_FILM_FRANCHISE = new RegExp(`${EDGE_BEFORE}(film|films|saga)${EDGE_AFTER}`, "iu");

export function classifyWikipediaCategories(categories = []) {
  const values = (Array.isArray(categories) ? categories : []).map((value) => String(value ?? ""));
  if (values.some((category) => WIKIPEDIA_DOCUMENTARY.test(category))) return WORK_KINDS.DOCUMENTARY;
  const television = values.some((category) => WIKIPEDIA_TELEVISION.test(category)
    // Une catégorie qui parle de film ET de série parle d'une franchise de cinéma, sauf si elle nomme franchement
    // la télévision par ailleurs (« Téléfilm », « Série télévisée américaine »).
    && !(WIKIPEDIA_FILM_FRANCHISE.test(category) && !/t[ée]l[ée]/iu.test(category)));
  return television ? WORK_KINDS.SERIES : WORK_KINDS.CINEMA;
}

// La nature d'une œuvre déjà rangée en base. Une nature enregistrée fait foi ; sinon on relit ce qu'on a :
// l'identifiant TMDb dit le support, et le snapshot local est une liste de films de cinéma — c'est de là qu'il
// a été extrait, et le supposer inconnu écarterait des milliers de vrais films du jeu.
const SNAPSHOT_SOURCES = new Set(["lovable-recovery", "snapshot", "manual"]);

export function workKind(work) {
  if (!work) return WORK_KINDS.UNKNOWN;
  if (isKnownKind(work.kind)) return work.kind;
  if (work.type === "tv" || work.externalIds?.tmdbTv) return WORK_KINDS.SERIES;
  if (SNAPSHOT_SOURCES.has(work.source)) return WORK_KINDS.CINEMA;
  return WORK_KINDS.UNKNOWN;
}

export function isWorkInScope(work, scope) {
  return (scope instanceof Set ? scope : scopeFromExtensions(scope)).has(workKind(work));
}

// Deux natures peuvent-elles désigner la même œuvre ? Une nature inconnue ne contredit personne — c'est ce qui
// laisse un crédit non classé compléter une fiche existante. Deux natures connues et différentes, en revanche,
// sont deux œuvres : c'est exactement le cas de l'émission « Beau geste » et du film « Beau Geste ».
export function kindsAreCompatible(left, right) {
  if (left === WORK_KINDS.UNKNOWN || right === WORK_KINDS.UNKNOWN) return true;
  return left === right;
}
