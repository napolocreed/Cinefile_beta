// Asking the catalogue whether a proposed link actually exists. Both game modes need it and neither owns it, so
// it lives on its own rather than being imported across screens.

import { applyLinkVerification, configExtensions } from "../game/engine.js";
import { app } from "./runtime.js";

export async function verifyPendingLink(game, pending) {
  if (pending.wasValid) return pending;
  const leftName = game.chain.at(-1);
  const left = app.database.findActor(leftName, game.config.themeId) ?? leftName;
  const right = app.database.findActor(pending.proposedActor, game.config.themeId) ?? pending.proposedActor;
  // La cascade cherche sous les règles de cette partie : hors extensions, une émission commune n'est pas une
  // preuve, et le serveur ne doit pas la retourner comme telle.
  const verification = await app.catalog.verifyLink(left, right, { extensions: configExtensions(game) });
  return applyLinkVerification(pending, verification);
}
