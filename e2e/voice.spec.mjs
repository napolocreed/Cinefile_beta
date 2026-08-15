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

async function startVoiceGame(page, { withClock = false, lives = null, players = ["Alice", "Bob"], bluffChallenges = true } = {}) {
  if (withClock) await page.clock.install();
  await page.addInitScript(RECOGNISER);
  await stubCatalog(page);
  await page.goto("/setup");
  await page.getByRole("button", { name: /Vocal passif/i }).click();
  for (const [index, name] of players.entries()) {
    if (index >= 2) await page.getByRole("button", { name: /Ajouter un joueur/i }).click();
    await page.getByPlaceholder(`Nom du joueur ${index + 1}`).fill(name);
  }
  if (lives) await page.locator("#lives-range").fill(String(lives));
  if (!bluffChallenges) await page.locator("#allow-bluff").uncheck();
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

// Le micro et le buzzer appartiennent au même siège : celui qui doit enchaîner. Ce test suit la chaîne sur un
// tour de table complet, puis un tour de plus, pour vérifier que la main circule bien de siège en siège.
test("the tour de table hands the microphone round the whole cast", async ({ page }) => {
  await startVoiceGame(page, { players: ["Alice", "Bob", "Carol", "Dan"] });
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  const stage = page.locator("[data-voice-stage]");
  await expect(stage).toHaveClass(/voice-stage--table/);
  await expect(page.locator(".voice-seat-chip")).toHaveCount(4);
  // Un seul panneau allumé : celui du joueur au micro, jamais quatre sièges de détail sur un téléphone.
  await expect(page.locator(".voice-player")).toHaveCount(1);

  const seen = [];
  for (const name of ["Leonardo DiCaprio", "Kate Winslet", "Tom Hanks", "Meg Ryan", "Tom Cruise"]) {
    seen.push(await stage.getAttribute("data-voice-turn"));
    await validate(page, name, name);
  }
  // Quatre joueurs distincts, dans un ordre qui reprend au premier au cinquième nom.
  expect(new Set(seen).size).toBe(4);
  expect(seen[4]).toBe(seen[0]);
  // Le dernier nom reste en attente de verdict : la chaîne s'arrête un cran avant.
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio", "Kate Winslet", "Tom Hanks", "Meg Ryan"]);
  await expect(page.locator(".voice-tabled")).toContainText("Tom Cruise");
  // Un seul siège allumé, et il tient le micro comme le buzzer : c'est le même joueur qui tranche. Celui qui
  // vient de poser le nom est marqué comme tel, et n'a plus rien à décider.
  const lit = page.locator(".voice-seat-chip--active");
  await expect(lit).toHaveCount(1);
  await expect(lit).toContainText("à décider");
  await expect(lit).not.toContainText(seen[4]);
  await expect(page.locator(".voice-seat-chip").filter({ hasText: seen[4] })).toContainText("a proposé");
  await expect(page.getByRole("button", { name: /BLUFF/i })).toBeEnabled();
});

// Le cas qui sépare vraiment les deux lectures : un buzz *raté*. Sur une liaison confirmée, c'est le siège qui
// avait la décision qui paie — l'ancienne règle aurait facturé la vie au joueur d'avant, qui n'avait plus rien
// à jouer. À quatre joueurs, ces deux sièges sont distincts et le verdict le montre.
test("at four players a wrong buzz is charged to the seat that had the decision", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "One browser project covers the buzz verdict.");
  await startVoiceGame(page, { players: ["Alice", "Bob", "Carol", "Dan"] });
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  const stage = page.locator("[data-voice-stage]");
  const opener = await stage.getAttribute("data-voice-turn");
  await validate(page, "Leonardo DiCaprio", "Leonardo DiCaprio");
  const proposer = await stage.getAttribute("data-voice-turn");
  await validate(page, "Kate Winslet", "Kate Winslet");

  // Trois sièges distincts : qui a ouvert, qui vient de proposer, et qui doit maintenant trancher.
  const decider = await stage.getAttribute("data-voice-turn");
  expect(decider).not.toBe(opener);
  expect(decider).not.toBe(proposer);

  await page.getByRole("button", { name: /BLUFF/i }).click();
  // DiCaprio et Winslet partagent Titanic : le catalogue local tranche seul, sans VAR ni réseau.
  await page.getByRole("button", { name: /Vérifier le bluff/i }).click();
  await expect(page.locator(".voice-outcome .verdict")).toContainText("Liaison valide");
  await expect(page.locator(".voice-outcome")).toContainText("Le buzz était injustifié");
  const penalty = page.locator(".voice-outcome__penalty");
  await expect(penalty).toContainText(decider);
  await expect(penalty).not.toContainText(opener);
  await expect(penalty).not.toContainText(proposer);

  // La passation se mesure une fois la proposition retombée. Ici le siège ne change pas — il vient de perdre
  // une vie sur son propre buzz et garde la main — donc l'annonce ne doit parler que de la vie perdue. La
  // mesurer proposition encore posée faisait annoncer le siège d'après, qui n'a rien à jouer.
  const announcement = page.locator("p.sr-only[role='status']");
  await expect(announcement).toContainText("perd une vie");
  await expect(announcement).not.toContainText("Au tour de");

  // Et il enchaîne quand même : perdre une vie sur un buzz raté ne dispense pas de jouer.
  await page.getByRole("button", { name: /Continuer/i }).click();
  await expect(stage).toHaveAttribute("data-voice-turn", decider);
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio", "Kate Winslet"]);
});

// Perdre sa dernière vie, ce n'est pas perdre une vie de plus. La scène le disait par un seul mot en petit et
// une vignette un peu moins opaque — assez peu pour qu'une table prenne une mort pour un tour d'attente.
test("losing the last life is played as an exit, not as one more life lost", async ({ page }) => {
  await startVoiceGame(page, { players: ["Alice", "Bob", "Carol", "Dan"], lives: 1 });
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  await validate(page, "Leonardo DiCaprio", "Leonardo DiCaprio");
  await validate(page, "Kate Winslet", "Kate Winslet");
  const doomed = await page.locator("[data-voice-stage]").getAttribute("data-voice-turn");

  // Un buzz injustifié sur une liaison que le catalogue confirme : le siège qui décidait y laisse sa vie.
  await page.getByRole("button", { name: /BLUFF/i }).click();
  await page.getByRole("button", { name: /Vérifier le bluff/i }).click();
  const penalty = page.locator(".voice-outcome__penalty--out");
  await expect(penalty).toContainText(doomed);
  await expect(penalty).toContainText("éliminé");
  await expect(penalty.locator(".death-card")).toHaveText("FIN");

  await page.getByRole("button", { name: /Continuer/i }).click();
  // Le geste : la vignette du sortant s'éteint sous un carton de fin, une seule fois.
  const dying = page.locator(".voice-seat-chip--dying");
  await expect(dying).toHaveCount(1);
  await expect(dying).toContainText(doomed);
  await expect(page.locator(".voice-strike--out")).toContainText("sorti de la partie");
  // Et l'annonce ne dit plus « il lui reste 0 ».
  const announcement = page.locator("p.sr-only[role='status']");
  await expect(announcement).toContainText(`${doomed} est éliminé`);
  await expect(announcement).not.toContainText("Il lui reste");

  // Le flash retombé, le siège reste hors jeu — décoloré et barré, pas simplement en veilleuse.
  await expect(page.locator(".voice-seat-chip--dying")).toHaveCount(0, { timeout: 5000 });
  const out = page.locator(".voice-seat-chip--out");
  await expect(out).toHaveCount(1);
  await expect(out).toContainText(doomed);
  await expect(out).toContainText("éliminé");
});

// Le vocal était dispensé de la vérification automatique au motif que son buzzer central tenait lieu de défi. Or ce
// buzzer exige un coup en attente, que le raccourci ne posait jamais : rien n'était vérifié, deux cents noms
// inventés entraient dans la chaîne sans coût, et « sans chrono » rendait la partie infinie.
test("voice without bluff challenges verifies each link instead of accepting it blindly", async ({ page }) => {
  await startVoiceGame(page, { bluffChallenges: false, lives: 3 });
  await page.getByRole("button", { name: /Activer le micro/i }).click();

  // Le premier maillon ouvre la chaîne : il n'y a rien à vérifier.
  await validate(page, "leonardo dicaprio", /Leonardo DiCaprio/i);
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio"]);

  // Le second n'a aucune liaison prouvable : la consultation s'ouvre au lieu d'allonger la chaîne.
  await page.evaluate(() => window.__say("bernard tapie"));
  const pick = page.locator(".voice-pick").filter({ hasText: /Bernard Tapie/i });
  await expect(pick.first()).toBeVisible();
  await pick.first().click();

  const review = page.locator(".voice-review");
  await expect(review).toBeVisible();
  await expect(review.getByText(/Cette liaison tient-elle/i)).toBeVisible();
  // Aucun joueur n'a buzzé : l'écran ne doit pas s'annoncer comme un buzzer de bluff.
  await expect(review.getByText(/Buzzer bluff/i)).toHaveCount(0);
  // La chaîne n'a pas bougé tant que la table n'a pas tranché.
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio"]);

  // La cascade n'a rien trouvé : la table tranche, et le maillon refusé coûte une vie.
  await expect(page.getByRole("button", { name: /Bluff confirmé/i })).toBeVisible();
  await page.getByRole("button", { name: /Bluff confirmé/i }).click();
  expect(await chainOf(page)).toEqual(["Leonardo DiCaprio"]);
  const lives = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").players.map((player) => player.lives), CURRENT_GAME_KEY);
  expect(lives).toContain(2);
});
