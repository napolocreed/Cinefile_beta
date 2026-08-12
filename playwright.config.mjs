import { defineConfig } from "@playwright/test";
import chromiumLambda, { inflate } from "@sparticuz/chromium";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress } from "node:zlib";
import { extract } from "tar-fs";

const temporaryChromium = join(tmpdir(), "chromium");
const packageBin = resolve("node_modules/@sparticuz/chromium/bin");
const fontDirectory = join(tmpdir(), "fonts");
const browserCache = join(tmpdir(), "cinefil-chromium-cache");
mkdirSync(browserCache, { recursive: true });
process.env.FONTCONFIG_PATH ??= fontDirectory;
process.env.XDG_CACHE_HOME ??= browserCache;

async function inflateTar(filename, output) {
  if (filename.includes("fonts") && existsSync(join(fontDirectory, "Open_Sans/OpenSans-Regular.ttf"))) return;
  if (filename.includes("swiftshader") && existsSync(join(tmpdir(), "libGLESv2.so"))) return;
  mkdirSync(output, { recursive: true });
  await pipeline(createReadStream(join(packageBin, filename)), createBrotliDecompress(), extract(output, { chown: false }));
}

async function prepareChromium() {
  await Promise.all([
    inflateTar("fonts.tar.br", fontDirectory),
    inflateTar("swiftshader.tar.br", tmpdir()),
  ]);
  if (existsSync(temporaryChromium) && statSync(temporaryChromium).size > 1_000_000) return temporaryChromium;
  return inflate(join(packageBin, "chromium.br"));
}

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || await prepareChromium();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["line"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath, args: chromiumLambda.args.filter((argument) => argument !== "--single-process") },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:4173/api/catalog/status",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
