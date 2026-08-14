// La planche de contact : les profils déjà en boîte, à un tap de la feuille de casting. Ce qui se vérifie ici,
// c'est ce qu'aucun test unitaire ne peut voir — le nom qui atterrit dans la bonne ligne, la vignette qui ne
// bouge pas sous le doigt, la raison affichée quand le bouton refuse, et le profil sans historique qui existe
// vraiment dans le stockage à la fin du parcours.

import { test, expect } from "@playwright/test";

const PROFILES_KEY = "cinelink.profiles.v1";

const profile = (name, { games = 0, lastSeenAt = null } = {}) => ({
  name,
  xp: 0,
  games,
  wins: 0,
  filmsFound: 0,
  bluffsSucceeded: 0,
  bluffsCaught: 0,
  achievements: [],
  challengesMade: 0,
  challengesSuccessful: 0,
  lastSeenAt,
});

const seedProfiles = (page, profiles) => page.addInitScript(
  ([key, raw]) => localStorage.setItem(key, raw),
  [PROFILES_KEY, JSON.stringify(profiles)],
);

const readProfiles = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), PROFILES_KEY);

const seat = (page, index) => page.getByPlaceholder(`Nom du joueur ${index}`);
const chip = (page, name) => page.locator(".casting-chip").filter({ hasText: name });

test("with no profile yet, the sheet stays out of the way and the launch creates them", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.locator(".casting-chip")).toHaveCount(0);
  await expect(page.getByText(/deviennent des profils/i)).toBeVisible();

  await seat(page, 1).fill("Alice");
  await seat(page, 2).fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await expect(page.getByLabel("Ton artiste")).toBeVisible();

  const profiles = await readProfiles(page);
  expect(Object.keys(profiles).sort()).toEqual(["alice", "bob"]);
  expect(profiles.alice.games).toBe(0);
  expect(typeof profiles.alice.lastSeenAt).toBe("number");
});

test("one tap fills a seat, the same tap frees it", async ({ page }) => {
  await seedProfiles(page, {
    alice: profile("Alice", { games: 12, lastSeenAt: 300 }),
    bob: profile("Bob", { games: 4, lastSeenAt: 200 }),
    carol: profile("Carol", { lastSeenAt: 100 }),
  });
  await page.goto("/setup");
  await expect(page.locator(".casting-chip")).toHaveCount(3);
  await expect(page.locator(".casting-fold")).toHaveCount(0);

  await chip(page, "Alice").click();
  await expect(seat(page, 1)).toHaveValue("Alice");
  await expect(chip(page, "Alice")).toHaveAttribute("aria-pressed", "true");

  await chip(page, "Bob").click();
  await expect(seat(page, 2)).toHaveValue("Bob");
  await expect(page.getByRole("button", { name: /Lancer la partie/i })).toBeEnabled();

  await chip(page, "Alice").click();
  await expect(seat(page, 1)).toHaveValue("");
  await expect(chip(page, "Alice")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /Lancer la partie/i })).toBeDisabled();
  await expect(page.locator("[data-casting-hint]")).toContainText("deux noms");
});

test("the spelling on file wins over the one typed tonight", async ({ page }) => {
  await seedProfiles(page, { alice: profile("Alice", { games: 3, lastSeenAt: 10 }) });
  await page.goto("/setup");
  await seat(page, 1).fill("alice");
  await seat(page, 2).fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await expect(page.getByLabel("Ton artiste")).toBeVisible();
  const profiles = await readProfiles(page);
  expect(profiles.alice.name).toBe("Alice");
  expect(profiles.alice.games).toBe(3);
});

test("a duplicate typed by hand blocks the launch and says why", async ({ page }) => {
  await page.goto("/setup");
  await seat(page, 1).fill("Alice");
  await seat(page, 2).fill("ALICE");
  await expect(page.getByRole("button", { name: /Lancer la partie/i })).toBeDisabled();
  await expect(page.locator("[data-casting-hint]")).toContainText("même nom");
  await expect(page.locator(".field--doublon")).toHaveCount(2);
  await seat(page, 2).fill("Bob");
  await expect(page.locator(".field--doublon")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Lancer la partie/i })).toBeEnabled();
});

test("voice mode seats exactly two, and the sheet says so instead of failing silently", async ({ page }) => {
  await seedProfiles(page, {
    alice: profile("Alice", { lastSeenAt: 300 }),
    bob: profile("Bob", { lastSeenAt: 200 }),
    carol: profile("Carol", { lastSeenAt: 100 }),
  });
  await page.goto("/setup");
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  await chip(page, "Alice").click();
  await chip(page, "Bob").click();
  await expect(seat(page, 3)).toHaveCount(0);
  await expect(chip(page, "Carol")).toBeDisabled();
  await expect(page.locator("[data-casting-hint]")).toContainText("sièges");
});

test("forty profiles: six on the sheet, the rest folded away behind a filter", async ({ page }) => {
  const many = Object.fromEntries(Array.from({ length: 39 }, (_, index) => [
    `joueur${String(index).padStart(2, "0")}`,
    profile(`Joueur ${String(index).padStart(2, "0")}`, { games: index, lastSeenAt: 1000 - index }),
  ]));
  await seedProfiles(page, { ...many, zoe: profile("Zoé", { lastSeenAt: 1 }) });
  await page.goto("/setup");

  await expect(page.locator(".casting-chips > li")).toHaveCount(6);
  await expect(page.locator(".casting-chips .casting-chip__name").first()).toHaveText("Joueur 00");
  await page.locator(".casting-fold > summary").click();
  await expect(page.locator(".casting-fold > summary")).toContainText("34 autres profils");

  // Le filtre masque des lignes déjà rendues, sans accent ni requête : « zoe » retrouve « Zoé ».
  await page.locator("#casting-filter").fill("zoe");
  await expect(page.locator(".casting-list > li:not([hidden])")).toHaveCount(1);
  await expect(page.locator(".casting-list > li:not([hidden]) .casting-chip__name")).toHaveText("Zoé");
  await page.locator("#casting-filter").fill("qqqq");
  await expect(page.locator("[data-casting-empty]")).toBeVisible();
});

test("choosing a profile never shifts the neighbours under the finger", async ({ page }) => {
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
    `joueur${String(index).padStart(2, "0")}`,
    profile(`Joueur ${String(index).padStart(2, "0")}`, { lastSeenAt: 1000 - index }),
  ]));
  await seedProfiles(page, many);
  await page.goto("/setup");
  const firstBefore = await page.locator(".casting-chips .casting-chip").first().getAttribute("data-profile-key");
  await page.locator(".casting-chips .casting-chip").nth(4).click();
  const firstAfter = await page.locator(".casting-chips .casting-chip").first().getAttribute("data-profile-key");
  expect(firstAfter).toBe(firstBefore);
  await expect(seat(page, 1)).toHaveValue("Joueur 04");
  // Et le focus reste sur la vignette actionnée : un utilisateur clavier ne repart pas du haut de page.
  await expect(page.locator(".casting-chips .casting-chip").nth(4)).toBeFocused();
});

test("a profile that never played shows as such, and can be forgotten in two taps", async ({ page }) => {
  await seedProfiles(page, { chloe: profile("Chloé", { lastSeenAt: 42 }) });
  await page.goto("/profiles");
  await expect(page.getByText("Jamais tourné")).toBeVisible();

  // L'export emporte bien un profil sans historique.
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exporter" }).click();
  const stream = await (await downloadPromise).createReadStream();
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  expect(JSON.parse(raw).data.profiles.chloe.games).toBe(0);

  const forget = page.getByRole("button", { name: /Oublier ce profil/i });
  await forget.click();
  await expect(page.getByRole("button", { name: /Confirmer l’oubli/i })).toBeVisible();
  await page.getByRole("button", { name: /Confirmer l’oubli/i }).click();
  await expect(page.getByText(/n’est plus dans les archives/i)).toBeVisible();
  expect(await readProfiles(page)).toEqual({});
});

test("the contact sheet stays within a phone screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Ce garde-fou ne vaut que sur la largeur téléphone.");
  await seedProfiles(page, Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `joueur${index}`,
    profile(`Joueur ${index}`, { lastSeenAt: 100 - index }),
  ])));
  await page.goto("/setup");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const chips = page.locator(".casting-chip");
  for (let index = 0; index < await chips.count(); index += 1) {
    const box = await chips.nth(index).boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  expect((await page.locator(".casting-chips").boundingBox()).height).toBeLessThan(190);
});
