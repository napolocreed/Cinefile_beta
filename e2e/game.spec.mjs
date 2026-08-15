import { test, expect } from "@playwright/test";


test("classic game setup and opening turn work without browser errors", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
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

// Le décompte ne vivait que dans l'écran : navigate() le remettait à null et ensureTimer repartait de la durée
// pleine. Un joueur à court de temps sortait par « ← Accueil », revenait, et retrouvait un chrono neuf — autant de
// fois qu'il le voulait. L'échéance vit désormais avec la partie.
test("the turn clock keeps running across a trip to the home screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "Un seul navigateur suffit pour une horloge.");
  await page.goto("/");
  await page.getByRole("link", { name: /Nouvelle partie/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await expect(page.getByLabel("Ton artiste")).toBeVisible();

  const readClock = async () => Number((await page.locator("[data-timer]").textContent()).replace(/\D+/g, ""));
  const full = await readClock();
  expect(full).toBeGreaterThan(5);

  // On laisse filer quelques secondes, puis on quitte l'écran et on y revient.
  await expect.poll(readClock, { timeout: 10_000 }).toBeLessThanOrEqual(full - 3);
  const beforeLeaving = await readClock();
  await page.getByRole("link", { name: /Accueil/i }).first().click();
  await page.getByRole("link", { name: /Reprendre/i }).click();
  await expect(page.getByLabel("Ton artiste")).toBeVisible();

  // Le chrono reprend où il en était, à la seconde de trajet près — il ne repart pas de la durée pleine.
  const afterReturning = await readClock();
  expect(afterReturning).toBeLessThanOrEqual(beforeLeaving);
  expect(afterReturning).toBeLessThan(full - 2);
});

test("installed app shell reopens the setup route offline", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One offline browser project is sufficient.");
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.goto("/setup");
  await expect(page.getByRole("heading", { name: "Nouvelle partie" })).toBeVisible();
});

test("portable backup downloads as a validated JSON document", async ({ page }) => {
  await page.goto("/profiles");
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
  await page.goto("/setup");
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
  await page.goto("/setup");
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  await page.getByPlaceholder("Nom du joueur 1").fill("Alice");
  await page.getByPlaceholder("Nom du joueur 2").fill("Bob");
  await page.getByRole("button", { name: /Lancer la partie/i }).click();
  await page.getByText("Correction / saisie de secours").click();
  await page.getByLabel(/Nom entendu pour/i).fill("alors moi je dis jean du jardin");
  await page.getByRole("button", { name: "Détecter" }).click();
  await expect(page.locator(".voice-pick__name").first()).toHaveText("Jean Dujardin");
});

// La règle du défi : une fois l'acteur A posé par le joueur 1 et B par le joueur 2, c'est le joueur 3 — celui
// qui doit accrocher C à B — qui arbitre. Le moteur donnait la décision au joueur précédent ; à deux joueurs
// les deux se confondent, et c'est ce qui a rendu l'erreur invisible partout ailleurs. Ce test se joue donc à
// trois, le premier nombre où les deux lectures divergent.
test("the bluff decision goes to the next player, not to the one who already played", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the challenge hand-over.");
  const cast = ["Alice", "Bob", "Carol"];
  await page.goto("/setup");
  await page.getByPlaceholder("Nom du joueur 1").fill(cast[0]);
  await page.getByPlaceholder("Nom du joueur 2").fill(cast[1]);
  await page.getByRole("button", { name: /Ajouter un joueur/i }).click();
  await page.getByPlaceholder("Nom du joueur 3").fill(cast[2]);
  await page.getByRole("button", { name: /Lancer la partie/i }).click();

  // Le joueur d'ouverture est tiré au sort : le test suit le compteur plutôt que de nommer qui que ce soit.
  // textContent et non innerText : la marquise passe les noms en capitales, et le test compare des noms saisis.
  const seat = page.locator(".reel-counter__name");
  const opener = await seat.textContent();
  await page.getByLabel("Ton artiste").fill("Leonardo DiCaprio");
  await page.getByRole("option", { name: /Leonardo DiCaprio/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();

  // L'ouverture se résout sans écran de défi et repeint le même formulaire : la souche d'acteur précédent est
  // le seul signal que le tour a bien tourné, et lire le compteur avant elle donnerait le nom d'avant.
  await expect(page.locator(".cue__name")).toHaveText("Leonardo DiCaprio");
  const proposer = await seat.textContent();
  expect(proposer).not.toBe(opener);
  await page.getByLabel("Ton artiste").fill("Kate Winslet");
  await page.getByRole("option", { name: /Kate Winslet/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();

  const decider = cast.find((name) => name !== opener && name !== proposer);
  await expect(page.locator(".play .prose")).toContainText(`${decider}, à toi de décider`);
  // Et surtout pas celui qui vient de poser le maillon précédent.
  await expect(page.locator(".play .prose")).not.toContainText(opener);

  // Un seul passage de téléphone par tour : qui tranche est aussi qui enchaîne.
  await page.getByRole("button", { name: /Laisser passer/i }).click();
  await expect(seat).toHaveText(decider);
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
  await page.goto("/setup");
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
  // Le verdict dit d'où il vient, et la règle qui compte est portée par la citation.
  await expect(page.locator(".var-quote__line")).toContainText("absence of evidence");
  await expect(page.locator(".var-quote__by")).toContainText("Boondocks");
  await expect(page.getByText(/la table tranche/i)).toBeVisible();
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
  await page.goto("/setup");
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

// Le symptôme rapporté depuis une table de quatre : des joueurs « disparaissaient » puis revenaient un tour
// plus tard, l'ordre semblant tiré au sort. C'était le défi rendu au joueur *précédent* : le téléphone partait
// chez quelqu'un qui avait déjà joué, puis revenait. Ce test épingle la propriété qui manquait — une seule
// passation par tour : qui arbitre est qui enchaîne.
test("the device passes once per turn: whoever arbitrates is whoever plays next", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the hand-over order.");
  await page.route("https://image.tmdb.org/**", (route) => route.abort());
  await page.goto("/setup");
  for (const [index, name] of ["Alice", "Bob", "Carol", "Dan"].entries()) {
    if (index >= 2) await page.getByRole("button", { name: /Ajouter un joueur/i }).click();
    await page.getByPlaceholder(`Nom du joueur ${index + 1}`).fill(name);
  }
  await page.locator("#no-timer").check();
  await page.getByRole("button", { name: /Lancer la partie/i }).click();

  const order = [];
  for (const name of ["Leonardo DiCaprio", "Kate Winslet", "Tom Hanks", "Meg Ryan", "Tom Cruise", "Michael Caine"]) {
    order.push(`tape:${(await page.locator(".reel-counter__name").textContent()).trim()}`);
    await page.getByLabel("Ton artiste").fill(name);
    const option = page.getByRole("option", { name: new RegExp(name, "i") }).first();
    if (await option.count()) await option.click();
    await page.getByRole("button", { name: /Valider/i }).click();
    // Valider fait un aller-retour réseau : l'écran n'a tourné que lorsque le champ est vide ou remplacé.
    await page.waitForFunction(() => {
      const field = document.querySelector("#actor-input");
      return !field || field.value === "";
    });
    if (await page.locator("[data-pass-challenge]").count()) {
      order.push(`decide:${(await page.locator(".play .prose").textContent()).split(",")[0].trim()}`);
      await page.getByRole("button", { name: /Laisser passer/i }).click();
      await expect(page.getByLabel("Ton artiste")).toBeVisible();
    }
  }

  // La propriété, et non la séquence : le siège d'ouverture est tiré au sort.
  const decisions = order.filter((step) => step.startsWith("decide:"));
  expect(decisions.length).toBeGreaterThanOrEqual(4);
  // La dernière décision n'a pas de suite observée : la boucle s'arrête là.
  for (const [index, step] of order.slice(0, -1).entries()) {
    if (!step.startsWith("decide:")) continue;
    expect(order[index + 1], `après ${step}, l'écran a réclamé ${order[index + 1]}`).toBe(`tape:${step.slice(7)}`);
  }
});

// Une élimination ne se disait nulle part en classique : le joueur sorti cessait simplement de recevoir le
// téléphone. C'est l'autre moitié des « joueurs disparus ».
test("an elimination is spelled out on the verdict screen", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the elimination notice.");
  await page.route("https://image.tmdb.org/**", (route) => route.abort());
  await page.route("**/api/verify-link*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ verdict: "NOT_FOUND", source: "none", films: [], evidence: [], durationMs: 90, steps: [], searchLinks: {} }),
  }));
  await page.goto("/setup");
  for (const [index, name] of ["Alice", "Bob", "Carol", "Dan"].entries()) {
    if (index >= 2) await page.getByRole("button", { name: /Ajouter un joueur/i }).click();
    await page.getByPlaceholder(`Nom du joueur ${index + 1}`).fill(name);
  }
  await page.locator("#lives-range").fill("1");
  await page.locator("#no-timer").check();
  await page.getByRole("button", { name: /Lancer la partie/i }).click();

  const settle = () => page.waitForFunction(() => {
    const field = document.querySelector("#actor-input");
    return !field || field.value === "";
  });
  await page.getByLabel("Ton artiste").fill("Leonardo DiCaprio");
  await page.getByRole("option", { name: /Leonardo DiCaprio/i }).first().click();
  await page.getByRole("button", { name: /Valider/i }).click();
  await settle();

  const doomed = (await page.locator(".reel-counter__name").textContent()).trim();
  await page.getByLabel("Ton artiste").fill("Artiste Totalement Inconnu");
  await page.getByRole("button", { name: /Valider/i }).click();
  await settle();
  await page.getByRole("button", { name: /Bluff !/i }).click();
  await page.getByRole("button", { name: /Bluff confirmé/i }).click();

  // Le verdict annonce la sortie avant le « Continuer », pas après.
  const strike = page.locator(".reveal-strike--out");
  await expect(strike).toBeVisible();
  await expect(strike).toContainText(doomed);
  await expect(strike).toContainText("éliminé");
  await expect(strike.locator(".death-card")).toHaveText("FIN");
});
