import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// Les « bad ports » de la spécification fetch : le client refuse de s'y connecter avant même d'ouvrir la socket,
// et l'échec ne ressemble pas à un serveur absent — c'est un « bad port » sec. Le tirage 4300-5299 contenait 5060
// et 5061 (SIP), soit deux chances sur mille par démarrage de rendre la CI rouge sans qu'aucun code applicatif ne
// soit en cause. Le serveur, lui, écoutait parfaitement.
const BLOCKED_PORTS = new Set([4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function testPort() {
  let port;
  do {
    port = 4300 + Math.floor(Math.random() * 1000);
  } while (BLOCKED_PORTS.has(port));
  return port;
}

async function startServer(env = {}) {
  const port = testPort();
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), ...env },
    stdio: "ignore",
  });
  let lastError = null;
  let response;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`);
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  // Sans cette garde, un démarrage manqué rendait `response` à undefined et l'échec ne se voyait que bien plus
  // loin, sous la forme d'un « fetch failed » sans rapport apparent avec le port.
  if (!response) {
    server.kill();
    throw new Error(`Le serveur de test n'a pas répondu sur le port ${port} : ${lastError?.cause?.message ?? lastError?.message ?? "cause inconnue"}`);
  }
  return { server, port, response };
}

test("the standalone server serves the app shell, source modules and SPA routes", async () => {
  const { server, port, response } = await startServer();
  try {
    assert.equal(response?.status, 200);
    assert.match(await response.text(), /Ciné-Fil/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/setup`)).status, 200);
    const mainSource = await fetch(`http://127.0.0.1:${port}/src/main.js`);
    assert.equal(mainSource.status, 200);
    assert.equal(mainSource.headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`)).status, 200);
    const serviceWorker = await fetch(`http://127.0.0.1:${port}/sw.js`);
    assert.equal(serviceWorker.status, 200);
    assert.equal(serviceWorker.headers.get("cache-control"), "no-cache");
    const catalogStatus = await (await fetch(`http://127.0.0.1:${port}/api/catalog/status`)).json();
    assert.equal(catalogStatus.configured, false);
    assert.equal(catalogStatus.verification.enabled, true);
    const invalidVerification = await fetch(`http://127.0.0.1:${port}/api/verify-link?left=A&right=B`);
    assert.equal(invalidVerification.status, 400);
    const database = await (await fetch(`http://127.0.0.1:${port}/src/data/cinema-database.json`)).json();
    assert.equal(database.actors.length > 1000, true);
    const snapshot = await (await fetch(`http://127.0.0.1:${port}/src/data/cinema-knowledge.json`)).json();
    assert.equal(snapshot.people.length > 1000, true);
    const publishedPerson = await (await fetch(`http://127.0.0.1:${port}/api/catalog/people/local/person_0rl93xi`)).json();
    assert.equal(publishedPerson.source, "published-tmdb");
    assert.equal(publishedPerson.person.localPersonId, "person_0rl93xi");
    assert.equal(publishedPerson.person.credits.length > 100, true);
    assert.equal(typeof publishedPerson.person.credits[0].title, "string");
  } finally {
    server.kill();
  }
});

// decodeURIComponent lève sur un pourcentage tronqué, et le handler passé à createServer est async : l'URIError
// devenait une promesse rejetée non gérée et Node arrêtait le processus. Une requête — un lien coupé, un crawler —
// coupait /api/verify-link pour toutes les tables en cours.
test("a malformed URL costs a response, never the server", async () => {
  const { server, port, response } = await startServer();
  try {
    assert.equal(response?.status, 200);
    // Trois façons d'écrire un pourcentage invalide, toutes rattrapées.
    for (const path of ["/%E0%A4%A", "/%%%", "/src/%ZZ"]) {
      const answer = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(answer.status < 500, true, `${path} a rendu ${answer.status}`);
      await answer.text();
    }
    // Et le serveur répond encore, sur les fichiers comme sur l'API.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/catalog/status`)).status, 200);
  } finally {
    server.kill();
  }
});

test("a declared origin may borrow the API, and nothing else may", async () => {
  const origin = "https://napolocreed.github.io";
  const { server, port } = await startServer({ ALLOWED_ORIGINS: `${origin}, https://cinefil.exemple.app/` });
  const api = `http://127.0.0.1:${port}/api/catalog/search?query=zendaya`;
  try {
    const preflight = await fetch(api, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "accept" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "accept");
    assert.equal(preflight.headers.get("vary"), "Origin");
    const search = await fetch(api, { headers: { Origin: origin } });
    assert.equal(search.status, 200);
    assert.equal(search.headers.get("access-control-allow-origin"), origin);
    // A cached answer must never be replayed for another origin.
    assert.equal(search.headers.get("vary"), "Origin");
    // A trailing slash in the declared list is not a different site.
    assert.equal((await fetch(api, { headers: { Origin: "https://cinefil.exemple.app" } })).headers.get("access-control-allow-origin"), "https://cinefil.exemple.app");
    const foreign = await fetch(api, { headers: { Origin: "https://ailleurs.exemple" } });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
    assert.equal((await fetch(api, { method: "OPTIONS", headers: { Origin: "https://ailleurs.exemple", "Access-Control-Request-Method": "GET" } })).status, 403);
    // Borrowing is granted to the API, not to the whole server.
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { headers: { Origin: origin } })).headers.get("access-control-allow-origin"), null);
    const written = await fetch(`http://127.0.0.1:${port}/api/catalog/status`, { method: "POST", headers: { Origin: origin } });
    assert.equal(written.status, 405);
    assert.equal(written.headers.get("allow"), "GET, OPTIONS");
  } finally {
    server.kill();
  }
});

test("without a declared origin the API stays same-origin", async () => {
  const { server, port } = await startServer({ ALLOWED_ORIGINS: "" });
  const api = `http://127.0.0.1:${port}/api/catalog/status`;
  try {
    const status = await fetch(api, { headers: { Origin: "https://napolocreed.github.io" } });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("access-control-allow-origin"), null);
    assert.equal(status.headers.get("vary"), null);
    assert.equal((await fetch(api, { method: "OPTIONS", headers: { Origin: "https://napolocreed.github.io", "Access-Control-Request-Method": "GET" } })).status, 403);
  } finally {
    server.kill();
  }
});
