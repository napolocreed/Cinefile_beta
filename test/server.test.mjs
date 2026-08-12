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
    assert.equal((await fetch(`http://127.0.0.1:${port}/src/main.js`)).status, 200);
    const database = await (await fetch(`http://127.0.0.1:${port}/src/data/cinema-database.json`)).json();
    assert.equal(database.actors.length > 1000, true);
  } finally {
    server.kill();
  }
});
