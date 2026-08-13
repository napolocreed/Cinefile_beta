import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("the Pages build is static, subpath-aware and excludes server credentials", async () => {
  const output = await mkdtemp(join(tmpdir(), "cinefil-pages-"));
  try {
    const build = spawnSync(process.execPath, ["scripts/build-pages.mjs", "--base=/Cinefile_beta/"], {
      cwd: process.cwd(),
      env: { ...process.env, OUTPUT_DIR: output },
      encoding: "utf8",
    });
    assert.equal(build.status, 0, build.stderr);
    const index = await readFile(join(output, "index.html"), "utf8");
    assert.match(index, /<base href="\/Cinefile_beta\/"/);
    assert.match(index, /name="app-base" content="\/Cinefile_beta\/"/);
    assert.match(index, /name="catalog-mode" content="static"/);
    assert.equal(await readFile(join(output, "setup/index.html"), "utf8"), index);
    assert.equal(existsSync(join(output, "src/main.js")), true);
    assert.equal(existsSync(join(output, "src/data/tmdb-overlay.json")), true);
    assert.equal(existsSync(join(output, "src/server/tmdb.js")), false);
    assert.equal(existsSync(join(output, ".env")), false);
    assert.equal((await stat(join(output, "src/data/cinema-knowledge.json"))).size > 1_000_000, true);
    const allRuntimeText = `${index}\n${await readFile(join(output, "src/main.js"), "utf8")}`;
    assert.doesNotMatch(allRuntimeText, /eyJhbGciOi/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
