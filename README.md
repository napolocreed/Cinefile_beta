# Ciné-Fil

Ciné-Fil est un jeu local de chaîne cinéma et de bluff, reconstruit sans dépendance d’exécution à Lovable. L’application est mobile-first, installable, jouable hors connexion et habillée dans une direction artistique **Old School Hollywood**.

Version publique : <https://napolocreed.github.io/Cinefile_beta/>.

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

Le socle canonique contient :

- 1 523 identités uniques ;
- 41 914 œuvres canoniques ;
- 84 497 crédits ;
- 409 fusions de titres et une fusion d’identité traçables et réversibles ;
- 144 candidats ambigus maintenus en revue plutôt que fusionnés automatiquement.

La couverture TMDb publiée atteint désormais les 1 523 identités locales : 75 547 œuvres compactées et 162 784 crédits distants. Après fusion prudente, le catalogue utilisé en jeu atteint 91 873 œuvres et 203 228 crédits. Chaque association automatique possède au moins une œuvre commune; 16 cas de translittération, pseudonyme ou doublon TMDb ont été revus et consignés dans `src/data/tmdb-person-overrides.json`.

Le jeu fonctionne entièrement avec ce snapshot. Pour activer la recherche et l’enrichissement TMDb, copier `.env.example` vers `.env` et fournir l’une de ces variables :

```bash
TMDB_API_TOKEN=votre_jeton_v4
# ou TMDB_API_KEY=votre_cle_v3
```

Puis lancer localement avec `npm run dev:env`. Sur Railway, déclarer directement la variable dans l’environnement et conserver `npm start`.

Le secret reste côté serveur ou dans les secrets GitHub Actions. L’interface ne reçoit jamais la clé : GitHub Pages charge un overlay statique contrôlé, tandis que la cible Node peut interroger TMDb en direct.

Reproduire le snapshot canonique :

```bash
npm run build:data
```

Lancer une vague incrémentale TMDb, reprenable après interruption :

```bash
npm run sync:tmdb:env -- --limit=100
```

La sortie locale `src/data/tmdb-overlay.local.json` est ignorée par Git afin qu’une synchronisation soit contrôlée avant intégration. Le fichier publié `src/data/tmdb-overlay.json` utilise un schéma compact et référentiel; les homonymes ne sont acceptés qu’avec un recouvrement filmographique décisif.

Pour les rafraîchissements automatiques, créer dans GitHub `Settings → Secrets and variables → Actions` un secret de dépôt nommé `TMDB_API_TOKEN`. Le workflow `Enrich TMDb catalogue` rafraîchit ensuite le catalogue par lots de 100, rejoue les tests et redéploie Pages. Le jeton ayant été partagé hors du gestionnaire de secrets, le renouveler avant cette configuration est recommandé.

Sur Pages, le navigateur charge un index TMDb initial d’environ 756 Ko puis uniquement la filmographie de l’artiste sélectionné. Chaque shard consulté rejoint le cache hors ligne; le fichier source complet reste réservé à la génération et à la cible Node.

### Vérification universelle et VAR

Lorsqu’un bluff porte sur un lien absent du catalogue chargé, la cible Node consulte une cascade sans LLM : TMDb, Wikidata/QLever avec repli WDQS, puis Wikipédia en français et en anglais. Le contrat distingue quatre résultats :

- `CONFIRMED` : une œuvre structurée commune a été retrouvée ;
- `PROBABLE` : une page de film contient les deux noms, sans preuve structurée suffisante ;
- `NOT_FOUND` : toutes les sources disponibles ont répondu sans résultat ;
- `UNKNOWN` : réseau, quota, timeout ou surcharge empêchent de conclure.

Seul `CONFIRMED` tranche automatiquement. Tous les autres états ouvrent une salle **VAR** avec les indices disponibles, des liens de recherche et une décision humaine. Une absence de résultat n’est donc jamais assimilée à la preuve qu’un film n’existe pas.

Les confirmations positives enrichissent `cinefil.verification-cache.v1` sur l’appareil et deviennent immédiatement rejouables hors connexion. Les résultats négatifs ne sont jamais appris. Sur GitHub Pages, aucune API d’exécution n’est appelée : la VAR humaine et ses recherches externes restent disponibles. Définir `VERIFY_LINK_NETWORK=0` désactive également la cascade sur la cible Node sans casser le jeu.

Le cadrage, les alternatives étudiées et les écarts assumés sont consignés dans [le rapport de fallback universel](docs/rapport-fallback-universel.md).

## Tests

```bash
npm test             # 59 tests unitaires, intégration, données et propriétés
npm run test:e2e     # desktop + mobile avec un Chromium reproductible
npm run test:e2e:pages # mêmes parcours sous /Cinefile_beta/
npm run test:all     # totalité de la quality gate
```

La suite vérifie notamment le moteur de partie, 250 séquences pseudo-aléatoires, la déduplication, les alias, l’unicité TMDb, les preuves filmographiques, les shards différés, le cache hors ligne, le vocal, l’export/import, le serveur, la PWA et les parcours critiques sur deux tailles d’écran. GitHub Actions rejoue cette quality gate à chaque push et pull request.

## Données et confidentialité

Toutes les données joueur restent dans le navigateur :

- `cinelink.current.v1` : partie en cours ;
- `cinelink.history.v1` : historique limité ;
- `cinelink.profiles.v1` : profils et succès ;
- `cinefil.catalog-cache.v1` : enrichissements cinéma consultés ;
- `cinefil.verification-cache.v1` : liens positivement confirmés par la cascade ;
- `cinefil.settings.v1` : réglages locaux ;
- `cinefil.diagnostics.v1` : erreurs locales uniquement si l’utilisateur active cette option.

L’écran Profils permet d’exporter puis de restaurer ces données dans un JSON validé, sans compte ni serveur utilisateur.

## Architecture

- `src/main.js` : routes et interface navigateur.
- `src/styles.css` : système visuel responsive et accessibilité.
- `src/game/engine.js` : règles déterministes et transitions immuables.
- `src/game/database.js` : index canonique, alias, liens et recherche.
- `src/game/catalog.js` : recherche hybride et cache navigateur.
- `src/server/` : adaptateurs TMDb, catalogue publié et vérification Wikidata/Wikipédia côté serveur.
- `src/voice/` : capture vocale et résolution d’entités séparées.
- `src/data/` : snapshot, synonymes, registre d’identités revues, overlay TMDb compact, journal de fusion et métriques.
- `scripts/` : reconstruction des données, build Pages et synchronisation incrémentale.
- `test/` et `e2e/` : non-régression logique et navigateur.

Les fichiers minifiés récupérés restent sous `public/assets/` pour audit mais ne sont plus le runtime de l’application. Le dump du propriétaire est conservé sous `recovery/lovable-dump/`.

La progression détaillée et les quelques tâches nécessitant un jeton ou une validation éditoriale figurent dans [roadmap.md](roadmap.md).

## Déploiements

- **GitHub Pages** : `.github/workflows/pages.yml` construit une liste blanche statique compatible avec le sous-chemin du dépôt, génère les filmographies à la demande, teste le jeu et publie `dist/`. Aucun secret ni code serveur n’entre dans l’artefact.
- **Serveur Node** : `npm start` respecte `PORT`, sert le fallback SPA et expose `/api/catalog/*` ainsi que `/api/verify-link`, sans transmettre le jeton TMDb au navigateur. Cette cible est prête pour Railway, Render, Fly.io ou un hébergement équivalent dès qu’une fonction demande un backend permanent.

GitHub Pages est donc un premier hébergement, pas une limite produit : le frontend et le moteur ne dépendent pas de cette plateforme.

Les données et portraits enrichis proviennent de TMDb. This product uses the TMDB API but is not endorsed or certified by TMDB.
