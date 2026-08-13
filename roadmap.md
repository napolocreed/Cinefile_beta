# Ciné-Fil — feuille de route

Mise à jour le 13 août 2026. La reconstruction, le déploiement statique, la couverture TMDb et le fallback universel de vérification sont traités. Les cases restantes demandent surtout une validation éditoriale, juridique ou des essais sur appareils réels.

## Socle autonome — livré

- [x] Écrans accueil, configuration, partie, bluff, résultats et profils.
- [x] Direction artistique **Old School Hollywood**, responsive mobile et desktop.
- [x] Moteur déterministe séparé de l’interface : chaînes, vies, scores, séries, défis, éliminations et chronomètre.
- [x] Persistance locale idempotente, succès et reprise de partie.

## Phase 1 — connaissance cinéma — livrée

- [x] Snapshot canonique versionné : 1 523 identités uniques, 41 914 œuvres et 84 497 crédits.
- [x] Identifiants stables pour les personnes et les œuvres, schéma prêt à recevoir TMDb et IMDb.
- [x] Déduplication stricte et prudente de 409 groupes, avec journal réversible dans `src/data/cinema-merge-log.json`.
- [x] Dictionnaires d’alias pour noms d’usage, accents, ponctuation, translittérations et titres localisés.
- [x] File de revue pour les 144 rapprochements incertains; aucune fusion floue silencieuse.
- [x] Fusion traçable de l’unique doublon d’identité confirmé (`Samy Naceri` / `Samir Nasseri`) avec conservation de tous les alias et crédits.
- [x] Rapport reproductible dans `src/data/cinema-quality.json` et générateur `npm run build:data`.
- [ ] Revoir humainement les 144 candidats incertains au fil de l’enrichissement éditorial.

## Phase 2 — saisie sans friction — livrée

- [x] Autocomplétion sur toutes les personnes indexées et tous leurs alias.
- [x] Classement par qualité textuelle, popularité et richesse de filmographie.
- [x] Recherche hybride : index local immédiat, puis TMDb côté serveur.
- [x] Désambiguïsation avec portrait, département artistique, œuvres connues et provenance.
- [x] Hydratation de la filmographie à la sélection, sans exposer le secret TMDb au navigateur.
- [x] Cache local et repli hors connexion explicite.
- [x] Vote conservé pour un artiste réellement absent du catalogue.

## Phase 3 — couverture filmographique — livrée

- [x] Adaptateur TMDb pour artistes, alias, profils, rôles, crédits films/séries et identifiants externes.
- [x] Cache serveur à durée de vie limitée et cache navigateur persistant.
- [x] Synchronisation incrémentale reprenable via `npm run sync:tmdb`.
- [x] Correspondance exacte puis désambiguïsation par recouvrement filmographique unique; aucun homonyme choisi arbitrairement.
- [x] Couverture publiée : 1 523/1 523 identités locales, 75 547 œuvres TMDb compactées et 162 784 crédits distants.
- [x] Catalogue fusionné actuel : 1 523 personnes, 91 873 œuvres et 203 228 crédits.
- [x] Overlay normalisé v2, sans collision entre identifiants de films et de séries, validé par tests référentiels.
- [x] Unicité complète des IDs TMDb; chaque association automatique possède une preuve filmographique.
- [x] Registre auditable de 16 associations revues pour pseudonymes, translittérations ou doublons TMDb.
- [x] Build Pages shardée : index initial d’environ 756 Ko, filmographie chargée et mise en cache à la sélection.
- [x] Métriques de couverture, œuvres orphelines et personnes sans crédit.
- [x] Snapshots versionnés pour garder les validations rejouables.
- [x] Workflow Actions hebdomadaire, reprenable par lots de 100 et conforme à une fraîcheur inférieure à six mois.
- [ ] Ajouter le secret de dépôt GitHub `TMDB_API_TOKEN`, de préférence après rotation du jeton partagé, pour activer les vagues automatiques.
- [x] Étendre l’overlay à toutes les identités locales et résoudre la totalité de la file TMDb sans choix arbitraire.
- [ ] Évaluer Allociné séparément après validation juridique de ses droits, quotas et conditions de redistribution.

## Phase 4 — mode vocal passif — livrée en bêta jouable

- [x] Variante dédiée à exactement deux joueurs.
- [x] Deux sections de joueur avec vies, état actif et timer individuel.
- [x] Écoute continue via Web Speech API après consentement explicite.
- [x] Détection locale des entités, dictionnaires d’alias et complément TMDb si disponible.
- [x] Plusieurs propositions classées avec niveau de confiance.
- [x] Buzzer bluff central pendant la fenêtre de décision.
- [x] Après buzzer, sélection indépendante des deux derniers noms avant résolution.
- [x] Correction de la dernière identité sans corrompre la chaîne ni les statistiques.
- [x] Arrêt immédiat du micro, indicateur d’écoute et saisie de secours si le micro ou le réseau manque.
- [ ] Tester et calibrer les accents/bruits réels sur un panel de téléphones; la disponibilité de Web Speech dépend du navigateur et du système.

## Phase 5 — qualité produit — livrée

- [x] 59 tests unitaires, d’intégration, de données et de propriétés, dont 250 parties pseudo-aléatoires.
- [x] 8 parcours navigateur locaux et 11 parcours Pages réussis sur desktop/mobile, avec contrôles hors-ligne, sous-chemin, chargement différé et VAR.
- [x] CI GitHub avec rapport Playwright en cas d’échec.
- [x] Déploiement GitHub Pages depuis Actions, artefact sur liste blanche et garde anti-secret.
- [x] PWA installable et shell complet disponible hors connexion.
- [x] Navigation clavier, lien d’évitement, focus visible, régions live et libellés accessibles.
- [x] Contraste renforcé, réduction des animations et option de texte agrandi.
- [x] Export/import JSON validé des parties, profils, réglages et cache cinéma.
- [x] Diagnostics locaux strictement opt-in, limités à 30 entrées et jamais envoyés.

## Phase 6 — fallback universel et VAR — livrée

- [x] Endpoint serveur unique `/api/verify-link` et contrat explicite `CONFIRMED` / `PROBABLE` / `NOT_FOUND` / `UNKNOWN`.
- [x] TMDb prioritaire lorsqu’il est configuré, sans exposition du secret au navigateur.
- [x] Résolution multilingue des identités Wikidata puis intersection SPARQL sur acteurs, réalisateurs, scénaristes, compositeurs, producteurs, directeurs photo et monteurs.
- [x] QLever primaire, WDQS en secours, préfixes SPARQL explicites, timeout court et respect du `User-Agent` Wikimedia.
- [x] Recherche Wikipédia fr/en classée comme indice probable, jamais comme validation automatique.
- [x] Cache LRU serveur avec durée longue pour les preuves positives et courte pour les absences.
- [x] Coalescence des requêtes identiques, concurrence amont bornée et métriques anonymes dans `/api/catalog/status`.
- [x] Salle VAR Old School Hollywood avec preuves internes, recherches Google/DuckDuckGo/Qwant/Wikipédia et arbitrage humain.
- [x] Même arbitrage dans le mode classique et le mode vocal passif.
- [x] Apprentissage local réservé aux confirmations positives, persistant hors connexion et inclus dans l’export/import.
- [x] Repli statique Pages sans appel API et sans verdict négatif automatique.
- [x] Tests simulant réponses, timeouts, panne QLever, repli WDQS, cooccurrence Wikipédia, cache, surcharge, moteur, sauvegarde et parcours navigateur.
- [ ] Mesurer sur des parties réelles la distribution des sources, les latences P95 et les liens encore introuvables avant d’envisager IMDb local.

## Prochain cycle éditorial

1. Ajouter le secret GitHub `TMDB_API_TOKEN`, puis laisser les vagues hebdomadaires rafraîchir la couverture complète.
2. Examiner les 144 rapprochements de titres historiques et enrichir les dictionnaires de synonymes.
3. Tester le vocal sur Chrome Android, Safari iOS et plusieurs environnements sonores.
4. Déployer la cible Node pour mesurer les verdicts anonymes, les latences et les liens manquants observés en partie ; prioriser ensuite les zones faibles de la base.
5. Choisir un hébergement Node/Postgres dès qu’une fonction exige du temps réel, des comptes ou un traitement vocal serveur.
6. Effectuer un audit juridique avant toute intégration Allociné ou redistribution massive de données tierces.
