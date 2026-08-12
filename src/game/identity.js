const CHARACTER_FOLDS = Object.freeze({
  "Æ": "AE", "æ": "ae", "Œ": "OE", "œ": "oe", "Ø": "O", "ø": "o",
  "Ł": "L", "ł": "l", "Đ": "D", "đ": "d", "Ð": "D", "ð": "d",
  "Þ": "Th", "þ": "th", "ß": "ss", "ı": "i",
});

const foldCharacters = (value) => String(value ?? "").replace(/[ÆæŒœØøŁłĐđÐðÞþßı]/g, (character) => CHARACTER_FOLDS[character] ?? character);

export function normalizeText(value) {
  return foldCharacters(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function strictIdentityKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("fr")
    .replace(/[’`´]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function nameKeys(value) {
  const raw = String(value ?? "").trim();
  const keys = new Set([normalizeText(raw)]);
  if (raw.includes(",")) {
    const [family, ...given] = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (family && given.length) keys.add(normalizeText(`${given.join(" ")} ${family}`));
  }
  const tokens = normalizeText(raw).split(" ").filter(Boolean);
  if (tokens.length > 1) keys.add(tokens.join(" "));
  return [...keys].filter(Boolean);
}

export function stableId(prefix, value) {
  let hash = 0x811c9dc5;
  const input = `${prefix}:${String(value ?? "")}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(36).padStart(7, "0")}`;
}

export function parseYear(value) {
  const match = String(value ?? "").match(/(?:\(|\[|\s)(18\d{2}|19\d{2}|20\d{2})(?:\)|\]|\s*$)/);
  return match ? Number(match[1]) : null;
}

export function identityTokens(value) {
  return normalizeText(value).split(" ").filter(Boolean);
}

export function scoreTextMatch(query, candidate) {
  const needle = normalizeText(query);
  const haystack = normalizeText(candidate);
  if (!needle || !haystack) return 0;
  if (needle === haystack) return 1;
  if (haystack.startsWith(needle)) return 0.92;
  const queryTokens = identityTokens(needle);
  const candidateTokens = identityTokens(haystack);
  if (queryTokens.every((token) => candidateTokens.some((candidateToken) => candidateToken.startsWith(token)))) return 0.82;
  if (haystack.includes(needle)) return 0.72;
  if (needle.length >= 4 && isSubsequence(needle.replaceAll(" ", ""), haystack.replaceAll(" ", ""))) return 0.52;
  return 0;
}

function isSubsequence(needle, haystack) {
  let cursor = 0;
  for (const character of haystack) {
    if (character === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}
