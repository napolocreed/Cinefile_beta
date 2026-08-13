# Ciné-Fil — feuille de route

Mise à jour le 13 août 2026. La reconstruction, le premier déploiement statique et la première vague d’enrichissement sont traités. Les cases restantes demandent surtout du temps de calcul, une validation éditoriale ou des essais sur appareils réels.

## Socle autonome — livré

- [x] Écrans accueil, configuration, partie, bluff, résultats et profils.
- [x] Direction artistique **Old School Hollywood**, responsive mobile et desktop.
- [x] Moteur déterministe séparé de l’interface : chaînes, vies, scores, séries, défis, éliminations et chronomètre.
- [x] Persistance locale idempotente, succès et reprise de partie.

## Phase 1 — connaissance cinéma — livrée

- [x] Snapshot canonique versionné : 1 524 personnes, 41 914 œuvres et 84 501 crédits.
- [x] Identifiants stables pour les personnes et les œuvres, schéma prêt à recevoir TMDb et IMDb.
- [x] Déduplication stricte et prudente de 409 groupes, avec journal réversible dans `src/data/cinema-merge-log.json`.
- [x] Dictionnaires d’alias pour noms d’usage, accents, ponctuation, translittérations et titres localisés.
- [x] File de revue pour les 144 rapprochements incertains; aucune fusion floue silencieuse.
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

## Phase 3 — couverture filmographique — enrichissement en cours

- [x] Adaptateur TMDb pour artistes, alias, profils, rôles, crédits films/séries et identifiants externes.
- [x] Cache serveur à durée de vie limitée et cache navigateur persistant.
- [x] Synchronisation incrémentale reprenable via `npm run sync:tmdb`.
- [x] Correspondance exacte puis désambiguïsation par recouvrement filmographique unique; aucun homonyme choisi arbitrairement.
- [x] Première vague publiée : 100 personnes, 15 547 œuvres TMDb compactées et 20 233 crédits distants.
- [x] Catalogue fusionné actuel : 1 524 personnes, 49 585 œuvres et 97 278 crédits.
- [x] Overlay normalisé v2, sans collision entre identifiants de films et de séries, validé par tests référentiels.
- [x] Métriques de couverture, œuvres orphelines et personnes sans crédit.
- [x] Snapshots versionnés pour garder les validations rejouables.
- [x] Workflow Actions hebdomadaire, reprenable par lots de 100 et conforme à une fraîcheur inférieure à six mois.
- [ ] Ajouter le secret de dépôt GitHub `TMDB_API_TOKEN`, de préférence après rotation du jeton partagé, pour activer les vagues automatiques.
- [ ] Étendre progressivement l’overlay aux 1 424 personnes locales restantes et traiter les rares rapprochements qui resteraient indécis.
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

- [x] 39 tests unitaires, d’intégration, de données et de propriétés, dont 250 parties pseudo-aléatoires.
- [x] 7 parcours navigateur locaux et 9 parcours Pages réussis sur desktop/mobile, avec contrôles hors-ligne et sous-chemin.
- [x] CI GitHub avec rapport Playwright en cas d’échec.
- [x] Déploiement GitHub Pages depuis Actions, artefact sur liste blanche et garde anti-secret.
- [x] PWA installable et shell complet disponible hors connexion.
- [x] Navigation clavier, lien d’évitement, focus visible, régions live et libellés accessibles.
- [x] Contraste renforcé, réduction des animations et option de texte agrandi.
- [x] Export/import JSON validé des parties, profils, réglages et cache cinéma.
- [x] Diagnostics locaux strictement opt-in, limités à 30 entrées et jamais envoyés.

## Prochain cycle éditorial

1. Ajouter le secret GitHub `TMDB_API_TOKEN`, puis laisser les vagues hebdomadaires étendre la couverture.
2. Examiner les 144 rapprochements de titres historiques et enrichir les dictionnaires de synonymes.
3. Tester le vocal sur Chrome Android, Safari iOS et plusieurs environnements sonores.
4. Mesurer les liens manquants observés en partie et prioriser les zones faibles de la base.
5. Choisir un hébergement Node/Postgres dès qu’une fonction exige du temps réel, des comptes ou un traitement vocal serveur.
6. Effectuer un audit juridique avant toute intégration Allociné ou redistribution massive de données tierces.
