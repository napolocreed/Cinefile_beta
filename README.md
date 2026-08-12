# CinéFil — copie locale indépendante

Cette base reconstruit l'application publique CinéFil sans dépendance d'exécution à Lovable. L'interface est maintenant une application source autonome en JavaScript modulaire, avec un moteur de jeu testable et une direction artistique Old School Hollywood. Elle contient les écrans, la logique du jeu, la base acteurs/films, les profils, les succès, les résultats et tous les assets nécessaires.

Le dépôt combine deux extractions indépendantes du site public. Le dump fourni par le propriétaire est conservé sous `recovery/lovable-dump/` pour la traçabilité ; les chunks absents de ce dump (`play`, `results`) ont été récupérés séparément et intégrés à l'application fonctionnelle.

## Lancer le jeu

Prérequis : Node.js 20 ou supérieur.

```bash
npm run dev
```

Ouvrir ensuite <http://localhost:4173>. Depuis un téléphone sur le même Wi-Fi : `http://ADRESSE_IP_DU_PC:4173`.

## Tests

```bash
npm test
```

Les tests couvrent la normalisation et les liens cinéma, la création de partie, la chaîne, les défis de bluff, les vies, les éliminations, le chrono, la persistance idempotente des profils et le serveur SPA.

## Données locales

- `cinelink.current.v1`
- `cinelink.history.v1`
- `cinelink.profiles.v1`
- `cinelink.applied.v1`

## Architecture actuelle

- `src/main.js` : routes et interface navigateur.
- `src/styles.css` : direction artistique Old School Hollywood, responsive mobile-first.
- `src/game/engine.js` : règles déterministes et transitions de partie.
- `src/game/database.js` : index acteurs/films, liens communs et autocomplétion.
- `src/game/storage.js` : sauvegarde locale, historique et profils.
- `src/data/cinema-database.json` : snapshot de la base récupérée.
- `test/` : tests de non-régression.

Les fichiers minifiés de récupération restent présents sous `public/assets/` comme référence et pour audit, mais ils ne sont plus utilisés par l'application.

Le dump confirme qu'aucune source originale ni source map n'était exposée publiquement (`recovered_source_files: 0`). La reconstruction a donc été faite en rétro-ingénierie propre, avec des tests avant les futures évolutions.

La suite est détaillée dans [roadmap.md](roadmap.md).

## Déploiement

Le serveur respecte la variable `PORT` et peut être déployé tel quel sur Railway. Toutes les routes SPA retombent sur `public/index.html`.
