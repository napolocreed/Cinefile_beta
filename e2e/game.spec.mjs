import { test, expect } from "@playwright/test";

const PAGES_BASE = process.env.PAGES_E2E ? "/Cinefile_beta" : "";
const appPath = (route = "/") => `${PAGES_BASE}${route}`;

test("classic game setup and opening turn work without browser errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(appPath("/"));
  await expect(page.getByRole("heading", { name: /Le dernier à l’écran/i })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Aller au jeu" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#app")).toBeFocused();
  await page.getByRole("link", { name: /Nouvelle partie/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  // No hand-over screen any more: launching a game lands straight on the field the first player types into.
  await expect(page.getByLabel("Ton artiste")).toBeVisible();
  await page.getByLabel("Ton artiste").fill("Leonardo DiCaprio");
  await expect(page.getByRole("option", { name: /Leonardo DiCaprio/i }).first()).toBeVisible();
  await page.getByRole("option", { name: /Leonardo DiCaprio/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();
  await expect(page.getByText(/Acteur précédent/i)).toBeVisible();
  await expect(page.getByText("Leonardo DiCaprio", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("installed app shell reopens the setup route offline", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One offline browser project is sufficient.");
  await page.goto(appPath("/"));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.goto(appPath("/setup"));
  await expect(page.getByRole("heading", { name: "Nouvelle partie" })).toBeVisible();
});

test("portable backup downloads as a validated JSON document", async ({ page }) => {
  await page.goto(appPath("/profiles"));
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exporter" }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  const backup = JSON.parse(raw);
  expect(backup.format).toBe("cinefil-backup");
  expect(backup.version).toBe(1);
  expect(backup.data.profiles).toEqual({});
});

test("passive voice only advances the chain on an explicit validation", async ({ page }) => {
  await page.goto(appPath("/setup"));
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  // The opening player is drawn at random, so the test follows the stage instead of naming them.
  // The banner that spelled out whose turn it was is gone — the dimmed seat says it. The stage still names the
  // active player for the test, which cannot see which panel is lit.
  const turn = page.locator("[data-voice-stage]");
  await expect(turn).toHaveAttribute("data-voice-turn", /\w/);
  const speaker = await turn.getAttribute("data-voice-turn");

  await page.getByText("Correction / saisie de secours").click();
  await page.getByLabel(/Nom entendu pour/i).fill("Leonardo DiCaprio");
  await page.getByRole("button", { name: "Détecter" }).click();
  await expect(page.locator(".voice-pick__name").filter({ hasText: "Leonardo DiCaprio" })).toBeVisible();
  // A detection alone must not hand the turn over.
  expect(await turn.getAttribute("data-voice-turn")).toBe(speaker);
  await expect(page.getByRole("button", { name: /BLUFF/i })).toBeDisabled();

  // A sentence without any artist leaves the pending proposition untouched.
  await page.getByLabel(/Nom entendu pour/i).fill("euh attends je réfléchis");
  await page.getByRole("button", { name: "Détecter" }).click();
  await expect(page.locator(".voice-pick__name").filter({ hasText: "Leonardo DiCaprio" })).toBeVisible();

  await page.locator(".voice-pick").filter({ hasText: "Leonardo DiCaprio" }).click();
  await expect(turn).not.toHaveAttribute("data-voice-turn", speaker);
  await expect(page.locator(".voice-chain")).toContainText("Leonardo DiCaprio");

  await page.getByLabel(/Nom entendu pour/i).fill("Kate Winslet");
  await page.getByRole("button", { name: "Détecter" }).click();
  await page.locator(".voice-pick").filter({ hasText: "Kate Winslet" }).click();
  await expect(page.getByRole("button", { name: /BLUFF/i })).toBeEnabled();
  await page.getByRole("button", { name: /BLUFF/i }).click();
  await expect(page.getByRole("heading", { name: /Qu’avez-vous vraiment dit/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Vérifier le bluff/i })).toBeEnabled();
});

test("passive voice recognises a French name through recognition spelling drift", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the matching behaviour.");
  await page.goto(appPath("/setup"));
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await page.getByText("Correction / saisie de secours").click();
  await page.getByLabel(/Nom entendu pour/i).fill("alors moi je dis jean du jardin");
  await page.getByRole("button", { name: "Détecter" }).click();
  await expect(page.locator(".voice-pick__name").first()).toHaveText("Jean Dujardin");
});

test("GitHub Pages keeps routes inside the repository subpath and makes no runtime API call", async ({ page }) => {
  test.skip(!process.env.PAGES_E2E, "Only relevant to the static Pages edition.");
  const apiRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/api/")) apiRequests.push(request.url());
  });
  await page.goto(appPath("/"));
  await page.getByRole("link", { name: /Nouvelle partie/i }).click();
  await expect(page).toHaveURL(/\/Cinefile_beta\/setup$/);
  await expect(page.getByRole("heading", { name: "Nouvelle partie" })).toBeVisible();
  expect(apiRequests).toEqual([]);
});

test("GitHub Pages lazily fetches only the selected enriched filmography", async ({ page }, testInfo) => {
  test.skip(!process.env.PAGES_E2E || testInfo.project.name !== "desktop", "One static browser project is sufficient.");
  const shardRequests = [];
  const monolithRequests = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/tmdb-shards/")) shardRequests.push(pathname);
    if (pathname.endsWith("/tmdb-overlay.json")) monolithRequests.push(pathname);
  });
  await page.goto(appPath("/"));
  expect(shardRequests).toEqual([]);
  await page.getByRole("link", { name: /Nouvelle partie/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await page.getByLabel("Ton artiste").fill("Gérard Depardieu");
  await page.getByRole("option", { name: /Gérard Depardieu/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();
  await expect.poll(() => shardRequests.length).toBe(1);
  expect(shardRequests[0]).toMatch(/\/tmdb-shards\/person_0rl93xi\.json$/);
  expect(monolithRequests).toEqual([]);
});

test("an uncertain bluff opens the human VAR without treating absence as proof", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the VAR decision flow.");
  await page.route("**/api/verify-link?*", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      verdict: "NOT_FOUND",
      source: "none",
      films: [],
      evidence: [],
      durationMs: 2400,
      steps: [
        { source: "tmdb", outcome: "empty", durationMs: 420, films: 0, error: null },
        { source: "wikidata", outcome: "empty", durationMs: 980, films: 0, error: null },
        { source: "wikipedia", outcome: "empty", durationMs: 1310, films: 0, error: null },
      ],
      searchLinks: {
        google: "https://www.google.com/search?q=cinema",
        wikipedia: "https://fr.wikipedia.org/w/index.php?search=cinema",
      },
    }),
  }));
  await page.goto(appPath("/setup"));
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await page.getByLabel("Ton artiste").fill("Leonardo DiCaprio");
  await page.getByRole("option", { name: /Leonardo DiCaprio/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();
  await page.getByLabel("Ton artiste").fill("Artiste Totalement Inconnu");
  await page.getByRole("button", { name: /Valider/i }).click();
  await page.getByRole("button", { name: /Bluff !/i }).click();
  await expect(page.getByRole("heading", { name: /La VAR vous rend la décision/i })).toBeVisible();
  // The Pages edition reaches this screen without contacting anything, and says so instead of blaming the network.
  await expect(page.getByText(/ne prouve jamais|jugement humain reste prioritaire|ne joint aucun service externe/i)).toBeVisible();
  // The cascade is reported in full: the local base first, then each external source that was actually asked.
  const steps = page.locator(".var-step");
  await expect(steps).toHaveCount(4);
  await expect(steps.first()).toContainText("base Ciné-Fil");
  await expect(steps.nth(3)).toContainText("Wikipédia");
  await expect(page.locator(".var-cascade__foot")).toContainText("Aucune source n’a produit de preuve");
  await expect(page.locator(".var-step--found")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Google/i })).toBeVisible();
  await page.getByRole("button", { name: /Bluff confirmé/i }).click();
  await expect(page.locator(".verdict--invalid")).toContainText("Invalide");
});

test("the closing credits replay the game, name the bluff nobody called, and step aside on a tap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the credits roll.");
  // The credits scroll; the assertions below read the document, so the roll is frozen rather than raced.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/verify-link?*", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ verdict: "NOT_FOUND", source: "none", films: [], evidence: [], durationMs: 900, steps: [], searchLinks: {} }),
  }));
  await page.goto(appPath("/setup"));
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.locator("#lives-range").fill("1");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();

  // Alice opens the reel.
  await page.getByLabel("Ton artiste").fill("Leonardo DiCaprio");
  await page.getByRole("option", { name: /Leonardo DiCaprio/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();

  // Bob bluffs, and Alice lets it through: nothing on screen ever says so again — until the credits.
  await page.getByLabel("Ton artiste").fill("Bourvil");
  await page.getByRole("option", { name: /Bourvil/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();
  await page.getByRole("button", { name: /Laisser passer/i }).click();

  // Alice bluffs in turn, Bob buzzes, and the last life goes.
  await page.getByLabel("Ton artiste").fill("Kate Winslet");
  await page.getByRole("option", { name: /Kate Winslet/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();
  await page.getByRole("button", { name: /Bluff !/i }).click();
  await page.getByRole("button", { name: /Bluff confirmé/i }).click();
  await page.getByRole("button", { name: /Continuer/i }).click();

  const credits = page.locator(".end-credits");
  await expect(credits).toBeVisible();
  await expect(credits).toContainText("Ciné-Fil présente");
  await expect(credits).toContainText("Distribution");
  // The chain, with the film that holds a pair together and the plain admission when there is none.
  await expect(credits.locator(".roll-chain__actor").first()).toContainText("Leonardo DiCaprio");
  await expect(credits.locator(".roll-chain__link--bluff")).toContainText("Bourvil");
  await expect(credits.locator(".roll-badge--bluff")).toContainText("Bluff jamais démasqué");
  // Named but never retained, and the sequence log tells the whole story back.
  await expect(credits.locator(".roll-guests")).toContainText("Kate Winslet");
  await expect(credits.locator(".roll-bluff--slipped")).toContainText("Bourvil");
  await expect(credits.locator(".roll-bluff--unmasked")).toContainText("Kate Winslet");
  await expect(credits.locator(".roll-log__scene")).toHaveCount(3);

  // A tap anywhere on the stage is all it takes to reach the scores.
  await credits.click({ position: { x: 5, y: 5 } });
  await expect(page.getByText(/Dans le rôle du vainqueur/i)).toBeVisible();
  // And the roll stays available afterwards, for whoever wants to read it properly.
  await page.getByRole("link", { name: /Revoir le générique/i }).click();
  await expect(page.locator(".end-credits")).toBeVisible();
});
