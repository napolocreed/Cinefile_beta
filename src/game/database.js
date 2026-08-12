export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function createDatabase(data) {
  const actorsByKey = new Map();
  const films = new Set(data?.films ?? []);

  for (const rawActor of data?.actors ?? []) {
    const name = String(rawActor.name ?? "").trim();
    const key = normalizeText(name);
    if (!key) continue;
    const previous = actorsByKey.get(key);
    const actor = {
      name,
      films: unique(rawActor.films ?? []),
      tags: unique(rawActor.tags ?? []),
    };
    actor.films.forEach((film) => films.add(film));
    if (!previous) actorsByKey.set(key, actor);
    else {
      previous.films = unique([...previous.films, ...actor.films]);
      previous.tags = unique([...previous.tags, ...actor.tags]);
    }
  }

  const actors = [...actorsByKey.values()];
  const filmKeysByActor = new Map(actors.map((actor) => [normalizeText(actor.name), new Set(actor.films.map(normalizeText))]));

  function isInTheme(actor, themeId = "classic") {
    return themeId !== "fr" || actor.tags.includes("fr");
  }

  function findActor(value, themeId = "classic") {
    const actor = actorsByKey.get(normalizeText(value));
    return actor && isInTheme(actor, themeId) ? actor : null;
  }

  function sharedFilms(left, right, themeId = "classic") {
    const leftActor = findActor(left, themeId);
    const rightActor = findActor(right, themeId);
    if (!leftActor || !rightActor) return [];
    const rightKeys = filmKeysByActor.get(normalizeText(rightActor.name));
    return leftActor.films.filter((film) => rightKeys.has(normalizeText(film)));
  }

  function searchActors(query, { themeId = "classic", excluded = [], limit = 6 } = {}) {
    const needle = normalizeText(query);
    if (!needle) return [];
    const excludedKeys = new Set(excluded.map(normalizeText));
    return actors
      .filter((actor) => isInTheme(actor, themeId))
      .filter((actor) => !excludedKeys.has(normalizeText(actor.name)))
      .filter((actor) => normalizeText(actor.name).includes(needle))
      .slice(0, limit)
      .map((actor) => actor.name);
  }

  return {
    actors,
    films: [...films],
    findActor,
    hasActor: (value, themeId = "classic") => Boolean(findActor(value, themeId)),
    isInTheme,
    searchActors,
    sharedFilms,
  };
}
