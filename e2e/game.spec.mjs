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
  await expect(page.getByText(/Passez l’écran à/i)).toBeVisible();
  await page.getByRole("button", { name: /Je suis prêt/i }).click();
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

test("passive voice fallback detects two names and opens bluff review", async ({ page }) => {
  await page.goto(appPath("/setup"));
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await expect(page.getByText(/Disponible après deux noms/i)).toBeVisible();
  await page.getByText("Correction / saisie de secours").click();
  await page.getByLabel(/Nom entendu pour/i).fill("Leonardo DiCaprio");
  await page.getByRole("button", { name: "Détecter" }).click();
  await expect(page.locator(".voice-detection strong").filter({ hasText: "Leonardo DiCaprio" })).toBeVisible();
  await page.getByText("Correction / saisie de secours").click();
  await page.getByLabel(/Nom entendu pour/i).fill("Kate Winslet");
  await page.getByRole("button", { name: "Détecter" }).click();
  await expect(page.getByRole("button", { name: /BLUFF/i })).toBeEnabled();
  await page.getByRole("button", { name: /BLUFF/i }).click();
  await expect(page.getByRole("heading", { name: /Qu’avez-vous vraiment dit/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Vérifier le bluff/i })).toBeEnabled();
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
