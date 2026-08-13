import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

test("the standalone server serves the app shell, source modules and SPA routes", async () => {
  const port = 4300 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  try {
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
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
