// A French-oriented phonetiser. Speech recognition writes plausible French spellings that rarely match a
// catalogue entry letter for letter ("de pardieu" for Depardieu, "du jardin" for Dujardin, "omar six" for
// Omar Sy). Both sides go through the same rules, so systematic approximations cancel each other out:
// consistency matters more than phonetic accuracy.

const LETTER_FOLDS = Object.freeze({
  "œ": "oe", "æ": "ae", "ç": "s", "ñ": "gn", "ß": "ss", "ø": "o",
  "đ": "d", "ð": "d", "þ": "t", "ı": "i", "ł": "l", "ø": "o",
});

const DIGIT_WORDS = ["zero", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf"];

export function phoneticNormalize(value) {
  return String(value ?? "")
    .toLocaleLowerCase("fr")
    .replace(/[œæçñßøđðþıł]/g, (character) => LETTER_FOLDS[character] ?? character)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Nasal vowels get their own symbols so "vincent" (v5s1) never collides with "vinsete".
export function phonetizeWord(word) {
  let value = String(word ?? "").replace(/[0-9]/g, (digit) => DIGIT_WORDS[Number(digit)] ?? " ").replace(/\s+/g, "");
  if (!value) return "";
  const silentFinalE = /e$/.test(value);

  value = value.replace(/sch/g, "S").replace(/ph/g, "f").replace(/th/g, "t").replace(/gn/g, "N");
  value = value.replace(/([bcdfgjklmnpqrstvxz])ill/g, "$1iy").replace(/ill/g, "y").replace(/([aeiou])il$/g, "$1y");
  value = value.replace(/ch/g, "S");

  value = value.replace(/(?:ain|aim|ein|eim|in|im|yn|ym|un|um)(?![aeiouymn])/g, "5");
  value = value.replace(/(?:ean|aen|aon|ent|en|em|an|am)(?![aeiouymn])/g, "1");
  value = value.replace(/(?:on|om)(?![aeiouymn])/g, "2");

  value = value.replace(/eau/g, "o").replace(/au/g, "o").replace(/ou/g, "u")
    .replace(/oeu|oe/g, "e").replace(/eu/g, "e")
    .replace(/ai|ei/g, "e").replace(/ay/g, "e")
    .replace(/oi|oy/g, "3");

  value = value.replace(/qu/g, "k").replace(/q/g, "k");
  value = value.replace(/c(?=[eiy5])/g, "s").replace(/c/g, "k");
  value = value.replace(/g(?=[eiy5])/g, "j");
  value = value.replace(/([aeiouy1235])s(?=[aeiouy1235])/g, "$1z");
  value = value.replace(/h/g, "").replace(/x/g, "ks").replace(/y/g, "i");
  value = value.replace(/(.)\1+/g, "$1");

  // A written final "e" silences nothing but itself; without it the last consonant is usually mute.
  if (silentFinalE) {
    if (value.length > 2) value = value.replace(/e$/, "");
  } else if (value.length >= 4) {
    value = value.replace(/(?:ts|ds|[tdspxz])$/, "");
  }
  return value;
}

export function phoneticTokens(value) {
  return phoneticNormalize(value).split(" ").filter(Boolean).map(phonetizeWord).filter(Boolean);
}

export function phoneticCode(value) {
  return phoneticTokens(value).join("");
}

// Optimal string alignment distance: substitutions, insertions, deletions and adjacent transpositions.
export function editDistance(left, right, cutoff = Infinity) {
  if (left === right) return 0;
  const lengthLeft = left.length;
  const lengthRight = right.length;
  if (!lengthLeft) return lengthRight;
  if (!lengthRight) return lengthLeft;
  if (Math.abs(lengthLeft - lengthRight) > cutoff) return cutoff + 1;

  let twoBack = new Array(lengthRight + 1).fill(0);
  let previous = new Array(lengthRight + 1);
  let current = new Array(lengthRight + 1);
  for (let column = 0; column <= lengthRight; column += 1) previous[column] = column;

  for (let row = 1; row <= lengthLeft; row += 1) {
    current[0] = row;
    let best = row;
    for (let column = 1; column <= lengthRight; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let value = Math.min(current[column - 1] + 1, previous[column] + 1, previous[column - 1] + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        value = Math.min(value, twoBack[column - 2] + 1);
      }
      current[column] = value;
      if (value < best) best = value;
    }
    if (best > cutoff) return cutoff + 1;
    const recycled = twoBack;
    twoBack = previous;
    previous = current;
    current = recycled;
  }
  return previous[lengthRight];
}

export function phoneticSimilarity(left, right) {
  const span = Math.max(left.length, right.length);
  if (!span) return 0;
  const cutoff = Math.ceil(span * 0.5);
  const distance = editDistance(left, right, cutoff);
  if (distance > cutoff) return 0;
  return 1 - distance / span;
}
