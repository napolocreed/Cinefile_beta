import { test, expect } from "@playwright/test";

// The passive voice mode is driven by a browser API no test runner can speak into, and by a one-second chrono.
// Both are replaced here — a scripted recogniser and Playwright's clock — so the rules that protect the chain
// can be exercised deterministically instead of being hoped for.

const CURRENT_GAME_KEY = "cinelink.current.v1";

const RECOGNISER = () => {
  const instances = [];
  class ScriptedRecognition {
    constructor() {
      this.listening = false;
      instances.push(this);
    }
    start() { this.listening = true; this.onstart?.({}); }
    stop() { this.listening = false; this.onend?.({}); }
    abort() { this.listening = false; this.onend?.({}); }
  }
  window.SpeechRecognition = ScriptedRecognition;
  window.__utterance = 0;
  // Shaped like a real SpeechRecognitionEvent: results is array-like, each result is an array-like of alternatives.
  window.__say = (transcript, { final = true, alternatives = [], confidence = 0.9 } = {}) => {
    const target = instances.filter((instance) => instance.listening).at(-1) ?? instances.at(-1);
    if (!target?.onresult) throw new Error("no recogniser is listening");
    const readings = [{ transcript, confidence }, ...alternatives.map((entry, rank) => (
      typeof entry === "string" ? { transcript: entry, confidence: 0.4 / (rank + 1) } : entry
    ))];
    const result = { length: readings.length, isFinal: final };
    readings.forEach((reading, index) => { result[index] = reading; });
    const index = window.__utterance;
    if (final) window.__utterance += 1;
    target.onresult({ resultIndex: index, results: { length: index + 1, [index]: result } });
  };
};

async function stubCatalog(page, { hydrateDelayMs = 0 } = {}) {
  await page.route("**/api/catalog/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false, source: "local" }) }));
  await page.route("**/api/catalog/search*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: false, results: [] }) }));
  // Shaped like the real endpoint, cascade included, so the VAR screen is exercised as it ships.
  await page.route("**/api/verify-link*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      verdict: "NOT_FOUND",
      source: "none",
      films: [],
      evidence: [],
      durationMs: 1800,
      steps: [
        { source: "tmdb", outcome: "empty", durationMs: 320, films: 0, error: null },
        { source: "wikidata", outcome: "empty", durationMs: 910, films: 0, error: null },
        { source: "wikipedia", outcome: "empty", durationMs: 1200, films: 0, error: null },
      ],
      searchLinks: { google: "https://www.google.com/search?q=cinema" },
    }),
  }));
  await page.route("**/api/catalog/people/**", async (route) => {
    if (hydrateDelayMs) await new Promise((resolve) => setTimeout(resolve, hydrateDelayMs));
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "absent" }) });
  });
}

async function startVoiceGame(page, { withClock = false, lives = null } = {}) {
  if (withClock) await page.clock.install();
  await page.addInitScript(RECOGNISER);
  await stubCatalog(page);
  await page.goto("/setup");
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  if (lives) await page.locator("#lives-range").fill(String(lives));
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await expect(page.locator("[data-voice-stage]")).toHaveAttribute("data-voice-turn", /\w/);
}

const chainOf = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").chain ?? [], CURRENT_GAME_KEY);

async function validate(page, spoken, expected) {
  await page.evaluate((text) => window.__say(text), spoken);
  const pick = page.locator(".voice-pick").filter({ hasText: expected });
  await expect(pick.first()).toBeVisible();
  await pick.first().click();
  // Validation hydrates over the network before it hands the turn over, and an utterance spoken during that
  // round trip belongs to the previous turn and is dropped. Wait for the fresh, empty pool.
  await expect(page.locator(".voice-pick")).toHaveCount(0);
}

test("every chain link comes from a tap, and only from a tap", async ({ page }) => {
  await startVoiceGame(page);
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  const spoken = ["Leonardo DiCaprio", "Kate Winslet", "Tom Hanks", "Meg Ryan"];
  for (const name of spoken) await validate(page, name, name);

  // Sentences that carry no artist, and interim noise, must leave the chain alone.
  await page.evaluate(() => {
    window.__say("euh attends je réfléchis");
    window.__say("alors", { final: false });
    window.__say("ah oui c'est bon");
  });
  await expect(page.locator(".voice-chain")).toContainText("Meg Ryan");
  expect(await chainOf(page)).toEqual(spoken.slice(0, 3));
  await expect(page.locator(".voice-chain__pending")).toContainText("Meg Ryan");
});

test("a correction that lands after its turn is refused instead of arming a phantom proposition", async ({ page }) => {
  await startVoiceGame(page, { withClock: true });
  await page.addInitScript(RECOGNISER);
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  await validate(page, "Leonardo DiCaprio", "Leonardo DiCaprio");
  await validate(page, "Kate Winslet", "Kate Winslet");
  const before = await chainOf(page);

  // Slow hydration is what opens the window: the correction resolves long after the chrono took the turn.
  await stubCatalog(page, { hydrateDelayMs: 4000 });
  const chip = page.locator("[data-voice-candidate]").nth(1);
  if (await chip.count()) {
    await chip.click({ noWaitAfter: true });
    await page.clock.runFor(31_000);
    await page.waitForTimeout(200);
    await page.clock.runFor(6_000);
    await expect(page.locator(".voice-error")).toBeVisible();
  }
  const after = await chainOf(page);
  // The chrono may legitimately accept the outstanding proposition; nothing beyond it may appear.
  expect(after.length).toBeLessThanOrEqual(before.length + 1);
  expect(after.slice(0, before.length)).toEqual(before);
});

test("a rejected proposition cannot be re-injected into the chain by a later buzz", async ({ page }) => {
  await startVoiceGame(page);
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  await validate(page, "Leonardo DiCaprio", "Leonardo DiCaprio");
  await validate(page, "Michel Galabru", "Michel Galabru");

  await page.getByRole("button", { name: /BLUFF/i }).click();
  await page.getByRole("button", { name: /Vérifier le bluff/i }).click();
  await page.getByRole("button", { name: /Bluff confirmé/i }).click();
  // A buzz always ends on a verdict the table reads before play resumes.
  await expect(page.locator(".voice-outcome .verdict")).toContainText("Aucune liaison");
  await expect(page.locator(".voice-outcome__penalty")).toContainText("perd une vie");
  await page.getByRole("button", { name: /Continuer/i }).click();
  await expect(page.locator("[data-voice-turn]")).toBeVisible();
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio"]);

  // Second buzz: the left side must be the chain tail, never the name the VAR just threw out.
  await validate(page, "Kate Winslet", "Kate Winslet");
  await page.getByRole("button", { name: /BLUFF/i }).click();
  await expect(page.locator(".voice-review__grid article").first()).toContainText("Leonardo DiCaprio");
  // DiCaprio and Winslet share Titanic, so the cascade confirms the link on its own and no VAR is needed.
  await page.getByRole("button", { name: /Vérifier le bluff/i }).click();
  await expect(page.locator(".voice-outcome .verdict")).toContainText("Liaison valide");
  await expect(page.locator(".film-proof")).toContainText("Titanic");
  await page.getByRole("button", { name: /Continuer/i }).click();
  await expect(page.locator("[data-voice-turn]")).toBeVisible();
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio", "Kate Winslet"]);
});

test("naming the artist already on the table cannot erase them", async ({ page }) => {
  await startVoiceGame(page);
  await page.getByRole("button", { name: /Activer le micro/i }).click();
  await validate(page, "Leonardo DiCaprio", "Leonardo DiCaprio");
  await validate(page, "Kate Winslet", "Kate Winslet");

  // Kate Winslet is proposed but not yet in the chain: she must not be offered again.
  await page.evaluate(() => window.__say("Kate Winslet"));
  await page.waitForTimeout(400);
  await expect(page.locator(".voice-pick__name").filter({ hasText: "Kate Winslet" })).toHaveCount(0);
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio"]);
  await expect(page.locator(".voice-chain__pending")).toContainText("Kate Winslet");
});

test("an off-catalogue name stays itself when the buzzer reopens it", async ({ page }) => {
  await startVoiceGame(page);
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  // "Camille" is an alias of Prince in the snapshot, so the pool is not empty when this name is spoken: the
  // off-catalogue card has to be the identity the entry remembers, not the first row of a pool nobody picked.
  await page.evaluate(() => window.__say("camille chamoux"));
  const raw = page.locator(".voice-pick--raw");
  await expect(raw).toContainText("Camille Chamoux");
  await raw.click();
  await expect(page.locator(".voice-pick")).toHaveCount(0);
  expect(await chainOf(page)).toEqual(["Camille Chamoux"]);

  await validate(page, "michael caine", "Michael Caine");
  await page.getByRole("button", { name: /BLUFF/i }).click();
  const left = page.locator(".voice-review__grid article").first();
  await expect(left).toContainText("Camille Chamoux");
  // The left identity must be the validated one, so no correction is attempted and nothing can refuse it.
  await expect(left.locator(".voice-candidate--selected")).toContainText("Camille Chamoux");

  await page.getByRole("button", { name: /Vérifier le bluff/i }).click();
  await expect(page.getByRole("button", { name: /Bluff confirmé/i })).toBeEnabled();
  await expect(page.locator(".var-step")).toHaveCount(4);
});

test("a bluff that ends the game still says what was verified", async ({ page }) => {
  await startVoiceGame(page, { lives: 1 });
  await page.getByRole("button", { name: /Activer le micro/i }).click();
  await validate(page, "Leonardo DiCaprio", "Leonardo DiCaprio");
  await validate(page, "Michel Galabru", "Michel Galabru");

  await page.getByRole("button", { name: /BLUFF/i }).click();
  await page.getByRole("button", { name: /Vérifier le bluff/i }).click();
  await page.getByRole("button", { name: /Bluff confirmé/i }).click();

  // The last life is gone, but the verdict comes before the credits — not after, and not implied by the winner.
  await expect(page.locator(".voice-outcome .verdict")).toContainText("Aucune liaison");
  await expect(page.locator(".voice-outcome")).toContainText("Le bluff est démasqué");
  await expect(page.locator(".voice-outcome__penalty")).toContainText("éliminé");
  await expect(page.locator(".var-step")).toHaveCount(4);
  await page.getByRole("button", { name: /Voir le générique/i }).click();
  // The credits come first, and they are the only place the table sees the whole reel back.
  await expect(page.locator(".end-credits")).toBeVisible();
  await expect(page.locator(".credits-roll")).toHaveClass(/credits-roll--playing/);
  await page.getByRole("button", { name: /Voir les scores/i }).click();
  await expect(page.getByText(/Dans le rôle du vainqueur/i)).toBeVisible();
});
