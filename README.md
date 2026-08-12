# CinéFil — copie locale indépendante

Cette base reproduit l'application publique CinéFil sans dépendance d'exécution à Lovable. Elle contient les écrans, la logique du jeu, la base acteurs/films, les profils, les succès, les résultats et tous les assets nécessaires.

Le dépôt combine deux extractions indépendantes du site public. Le dump fourni par le propriétaire est conservé sous `recovery/lovable-dump/` pour la traçabilité ; les chunks absents de ce dump (`play`, `results`) ont été récupérés séparément et intégrés à l'application fonctionnelle.

## Lancer le jeu

Prérequis : Node.js 20 ou supérieur.

```bash
npm run dev
```

Ouvrir ensuite <http://localhost:4173>. Depuis un téléphone sur le même Wi-Fi : `http://ADRESSE_IP_DU_PC:4173`.

## Données locales

- `cinelink.current.v1`
- `cinelink.history.v1`
- `cinelink.profiles.v1`
- `cinelink.applied.v1`

## État de la récupération

Cette première version est un miroir autonome et fidèle du build public retrouvé. Les fichiers minifiés ont été conservés afin de ne perdre ni la base cinéma ni un comportement du jeu. La prochaine étape recommandée est une migration progressive vers une base source TypeScript/Vite maintenable et testée, avant d'améliorer l'UX et le game design.

Le dump confirme qu'aucune source originale ni source map n'était exposée publiquement (`recovered_source_files: 0`). La reconstruction en TypeScript sera donc un travail de rétro-ingénierie propre, et non une simple restauration de fichiers source cachés.

## Déploiement

Le serveur respecte la variable `PORT` et peut être déployé tel quel sur Railway. Toutes les routes SPA retombent sur `public/index.html`.
