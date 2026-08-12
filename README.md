# Ciné-Fil

Ciné-Fil est un jeu local de chaîne cinéma et de bluff, reconstruit sans dépendance d’exécution à Lovable. L’application est mobile-first, installable, jouable hors connexion et habillée dans une direction artistique **Old School Hollywood**.

## Lancer le jeu

Prérequis : Node.js 20 ou supérieur.

```bash
npm install
npm run dev
```

Ouvrir <http://localhost:4173>. Depuis un téléphone sur le même Wi-Fi, utiliser `http://ADRESSE_IP_DU_PC:4173`.

## Modes de jeu

- **Classique** : passage d’écran, saisie assistée, chrono, vies et défis de bluff, de 2 à 10 joueurs.
- **Vocal passif** : deux joueurs, écoute continue, propositions de reconnaissance, timers séparés et buzzer central. Si Web Speech n’est pas disponible, la saisie de secours conserve tout le déroulé du mode.

Le micro ne démarre jamais sans action explicite et Ciné-Fil ne stocke aucun fichier audio.

## Catalogue cinéma

Le snapshot embarqué contient :

- 1 524 personnes ;
- 41 914 œuvres canoniques ;
- 84 501 crédits ;
- 409 fusions de titres traçables et réversibles ;
- 144 candidats ambigus maintenus en revue plutôt que fusionnés automatiquement.

Le jeu fonctionne entièrement avec ce snapshot. Pour activer la recherche et l’enrichissement TMDb, copier `.env.example` vers `.env` et fournir l’une de ces variables :

```bash
TMDB_API_TOKEN=votre_jeton_v4
# ou TMDB_API_KEY=votre_cle_v3
```

Puis lancer localement avec `npm run dev:env`. Sur Railway, déclarer directement la variable dans l’environnement et conserver `npm start`.

Le secret reste côté serveur. L’interface ne reçoit que les résultats nécessaires et les met en cache localement.

Reproduire le snapshot canonique :

```bash
npm run build:data
```

Lancer une vague incrémentale TMDb, reprenable après interruption :

```bash
npm run sync:tmdb:env -- --limit=100
```

La sortie locale `src/data/tmdb-overlay.local.json` est ignorée par Git afin qu’une synchronisation soit contrôlée avant intégration au snapshot public.

## Tests

```bash
npm test             # 35 tests unitaires, intégration, données et propriétés
npm run test:e2e     # desktop + mobile avec un Chromium reproductible
npm run test:all     # totalité de la quality gate
```

La suite vérifie notamment le moteur de partie, 250 séquences pseudo-aléatoires, la déduplication, les alias, TMDb, le cache hors ligne, le vocal, l’export/import, le serveur, la PWA et les parcours critiques sur deux tailles d’écran. GitHub Actions rejoue cette quality gate à chaque push et pull request.

## Données et confidentialité

Toutes les données joueur restent dans le navigateur :

- `cinelink.current.v1` : partie en cours ;
- `cinelink.history.v1` : historique limité ;
- `cinelink.profiles.v1` : profils et succès ;
- `cinefil.catalog-cache.v1` : enrichissements cinéma consultés ;
- `cinefil.settings.v1` : réglages locaux ;
- `cinefil.diagnostics.v1` : erreurs locales uniquement si l’utilisateur active cette option.

L’écran Profils permet d’exporter puis de restaurer ces données dans un JSON validé, sans compte ni serveur utilisateur.

## Architecture

- `src/main.js` : routes et interface navigateur.
- `src/styles.css` : système visuel responsive et accessibilité.
- `src/game/engine.js` : règles déterministes et transitions immuables.
- `src/game/database.js` : index canonique, alias, liens et recherche.
- `src/game/catalog.js` : recherche hybride et cache navigateur.
- `src/server/tmdb.js` : adaptateur TMDb côté serveur.
- `src/voice/` : capture vocale et résolution d’entités séparées.
- `src/data/` : snapshot, synonymes, journal de fusion et métriques.
- `scripts/` : reconstruction des données et synchronisation incrémentale.
- `test/` et `e2e/` : non-régression logique et navigateur.

Les fichiers minifiés récupérés restent sous `public/assets/` pour audit mais ne sont plus le runtime de l’application. Le dump du propriétaire est conservé sous `recovery/lovable-dump/`.

La progression détaillée et les quelques tâches nécessitant un jeton ou une validation éditoriale figurent dans [roadmap.md](roadmap.md).

## Déploiement

Le serveur respecte `PORT` et se déploie tel quel sur Railway ou un environnement Node. Le fallback SPA couvre toutes les routes; les endpoints `/api/catalog/*` n’exposent jamais le jeton TMDb.
