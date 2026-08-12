import { readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("public/assets/play-CyN2Gsmd.js", "utf8");

function expressionAfter(marker, open, close) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Marker not found: ${marker}`);
  const expressionStart = source.indexOf(open, start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = expressionStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "`" || character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return source.slice(expressionStart, index + 1);
    }
  }
  throw new Error(`Unclosed expression: ${marker}`);
}

const compactData = vm.runInNewContext(`(${expressionAfter("var d=", "{", "}")})`);
const curatedActors = vm.runInNewContext(`(${expressionAfter("var p=", "[", "]")})`);
const actors = new Map();
const normalize = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const add = (actor) => {
  const key = normalize(actor.name);
  const previous = actors.get(key);
  if (!previous) {
    actors.set(key, { name: actor.name, films: [...new Set(actor.films)], tags: [...new Set(actor.tags ?? [])] });
    return;
  }
  previous.films = [...new Set([...previous.films, ...actor.films])];
  previous.tags = [...new Set([...previous.tags, ...(actor.tags ?? [])])];
};
for (const actor of curatedActors) add(actor);
for (const actor of compactData.actors) {
  add({ name: actor.n, films: actor.f.map((filmIndex) => compactData.films[filmIndex]).filter(Boolean), tags: actor.t.split(",").filter(Boolean) });
}
const database = { version: 1, actors: [...actors.values()], films: [...new Set([...compactData.films, ...[...actors.values()].flatMap((actor) => actor.films)])] };
await writeFile("src/data/cinema-database.json", `${JSON.stringify(database)}\n`);
console.log(`Extracted ${database.actors.length} actors and ${database.films.length} films`);
