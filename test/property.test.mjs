import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase, normalizeText } from "../src/game/database.js";
import { alivePlayers, createGame, currentPlayer, proposeActor, resolvePending } from "../src/game/engine.js";

const database = createDatabase({
  actors: [
    { name: "Ada Actor", films: ["Film 1"], tags: [] },
    { name: "Benoît Bravo", films: ["Film 1", "Film 2"], tags: [] },
    { name: "Céline Cinema", films: ["Film 2", "Film 3"], tags: [] },
    { name: "Diego Drama", films: ["Film 3", "Film 4"], tags: [] },
    { name: "Emma Écran", films: ["Film 4"], tags: [] },
    { name: "Félix Fiction", films: ["Film 5"], tags: [] },
  ],
  films: ["Film 1", "Film 2", "Film 3", "Film 4", "Film 5"],
});

function randomFor(seed) {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

function assertInvariants(game, initialLives) {
  const normalizedChain = game.chain.map(normalizeText);
  assert.equal(new Set(normalizedChain).size, normalizedChain.length, "the chain contains a duplicate identity");
  assert.equal(game.players.every((player) => Number.isInteger(player.lives) && player.lives >= 0 && player.lives <= initialLives), true);
  if (game.status === "in-progress") {
    assert.equal(alivePlayers(game).length >= 2, true);
    assert.equal(currentPlayer(game).lives > 0, true, "an eliminated player received the turn");
  } else {
    assert.equal(alivePlayers(game).length <= 1, true);
    assert.equal(game.winnerId, alivePlayers(game)[0]?.id ?? null);
  }
}

test("random game sequences preserve core invariants across 250 seeds", () => {
  const known = database.people.map((person) => person.name);
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = randomFor(seed);
    const playerCount = 2 + Math.floor(random() * 5);
    const initialLives = 1 + Math.floor(random() * 5);
    let id = 0;
    let game = createGame({
      names: Array.from({ length: playerCount }, (_, index) => `Joueur ${index + 1}`),
      config: { livesPerPlayer: initialLives },
      random,
      now: () => seed,
      idFactory: () => `seed-${seed}-${++id}`,
    });
    assertInvariants(game, initialLives);

    for (let turn = 0; turn < 80 && game.status === "in-progress"; turn += 1) {
      const unused = known.filter((name) => !game.chain.some((entry) => normalizeText(entry) === normalizeText(name)));
      const chooseKnown = unused.length && random() > 0.3;
      const proposal = chooseKnown ? unused[Math.floor(random() * unused.length)] : `Invention ${seed} ${turn}`;
      const before = structuredClone(game);
      const result = proposeActor(game, proposal, database);
      assert.deepEqual(game, before, "proposeActor mutated its input");
      if (result.type === "pending") {
        const { pending } = result;
        // Le défi appartient au joueur suivant. Personne n'est invité à contester sa propre liaison, et la
        // décision ne revient jamais à un éliminé — deux propriétés que ni previousAliveIndex ni
        // nextAliveIndex ne violent, mais qui bornent la lecture.
        assert.notEqual(pending.challengerId, pending.playerId, "un joueur a été invité à contester sa propre liaison");
        const challenger = game.players.find((player) => player.id === pending.challengerId);
        assert.equal(Boolean(challenger) && challenger.lives > 0, true, "le défi a été confié à un joueur éliminé");
        const challenged = random() > 0.32;
        game = resolvePending(result.game, pending, { challenged });
        // Et la règle elle-même : laisser passer, c'est enchaîner. Celui qui pouvait crier au bluff est
        // exactement celui dont c'est le tour ensuite. C'est la seule assertion du dépôt qui distingue les
        // deux lectures sur autre chose qu'un casting figé — 250 graines, de deux à six sièges, éliminations
        // comprises.
        if (!challenged && game.status === "in-progress") {
          assert.equal(currentPlayer(game).id, pending.challengerId, "le tour n'est pas revenu à qui pouvait contester");
        }
      } else {
        game = result.game;
      }
      assertInvariants(game, initialLives);
    }

    if (game.status === "finished") {
      const frozen = structuredClone(game);
      assert.throws(() => proposeActor(game, "Dernier Acteur", database), /terminée/);
      assert.deepEqual(game, frozen, "a finished game changed after a rejected move");
    }
  }
});
