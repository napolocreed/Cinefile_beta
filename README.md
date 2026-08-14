# Ciné-Fil

Ciné-Fil est un jeu local de chaîne cinéma et de bluff, reconstruit sans dépendance d’exécution à Lovable. L’application est mobile-first, installable, jouable hors connexion et habillée dans une direction artistique **« Bobine & Souche »** : la pellicule 35 mm et la billetterie de cinéma.

Chaque écran du jeu tient dans une hauteur de téléphone, sans défilement. Les rails de perforation, les crans de souche de billet, les tampons d’archive et le grain argentique sont fabriqués en CSS : l’habillage ne coûte aucun fichier image et reste intact hors connexion. Trois familles portent la voix du jeu — Oswald pour la marquise, Courier Prime pour le scénario, Inter pour le corps de texte.

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
- **Vocal passif** : deux joueurs, écoute continue, timers séparés et buzzer central. L’écoute ne fait que **proposer** : les noms entendus s’accumulent sur le tour du joueur actif, qui touche la bonne carte pour valider et passer la main. Rien n’entre dans la chaîne sans ce geste. Si Web Speech n’est pas disponible, la saisie de secours conserve tout le déroulé du mode.
- **Un artiste absent du catalogue n'est jamais une impasse** : le nom entendu reste proposable tant que le catalogue n'a pas répondu avec quasi-certitude, avec un bouton pour en corriger l'orthographe. Sur la cible Node, un nom complet prononcé jusqu'au bout est cherché dans TMDb.
- **Le changement de tour et les pertes de vie s'annoncent** : bandeau de passation, sièges distincts (or et rouge, filet plein ou pointillé, chiffre romain), cœur qui meurt sur un emplacement qui reste visible, et le motif de la perte affiché en clair — chrono expiré, bluff démasqué, buzz injustifié ou liaison invalide.
- La reconnaissance des noms est **phonétique et française** : « jean du jardin » retrouve Jean Dujardin, « de pardieu » Gérard Depardieu, « omar six » Omar Sy. Une phrase sans nom d’artiste n’efface jamais les propositions déjà entendues.
- Chaque proposition porte le **portrait** de l’artiste, comme l’autocomplétion du mode classique. Hors connexion ou derrière un réseau filtrant, le cadre retombe sur l’initiale gravée plutôt que sur une image cassée.

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

La cascade rend compte d’elle-même : chaque réponse liste ses étapes dans l’ordre — base Ciné-Fil, TMDb, Wikidata, Wikipédia — avec leur issue (preuve, indice, rien trouvé, injoignable, inutile, abandonnée) et leur durée. L’écran de VAR affiche cette chronologie et met en évidence l’étape qui a produit la preuve, de sorte que la table voit d’où vient le verdict, ou que personne n’a rien trouvé.

Seul `CONFIRMED` tranche automatiquement. Tous les autres états ouvrent une salle **VAR** avec les indices disponibles, des liens de recherche et une décision humaine. Une absence de résultat n’est donc jamais assimilée à la preuve qu’un film n’existe pas.

Les confirmations positives enrichissent `cinefil.verification-cache.v1` sur l’appareil et deviennent immédiatement rejouables hors connexion. Les résultats négatifs ne sont jamais appris. Sur GitHub Pages, aucune API d’exécution n’est appelée : la VAR humaine et ses recherches externes restent disponibles. Définir `VERIFY_LINK_NETWORK=0` désactive également la cascade sur la cible Node sans casser le jeu.

Le cadrage, les alternatives étudiées et les écarts assumés sont consignés dans [le rapport de fallback universel](docs/rapport-fallback-universel.md).

## Générique de fin

Entre la dernière vie perdue et le tableau des scores, la partie déroule son propre générique — capitales condensées sur fond de salle, colonne étroite, machine à écrire pour ce qui relie les noms :

- **Distribution** : chaque joueur reçoit un titre tiré de sa manière de jouer (le dernier à l’écran, cascades sans doublure, au montage, à la documentation…) et sa ligne de crédits — raccords, films, bluffs, série, séquence de sortie.
- **Dans l’ordre d’apparition** : la chaîne complète, avec **le film qui tient chaque paire** écrit entre deux acteurs. Quand rien ne les relie, le générique l’écrit en rouge : c’est le bluff que personne n’a relevé, révélé ici et nulle part ailleurs. Un lien que le moteur n’avait pas su prouver est redemandé au catalogue au moment du générique, et crédité si les archives ont appris la paire depuis.
- **Avec la participation de** : les artistes nommés mais jamais retenus, avec le motif du refus.
- **Cascades et doublures** : le registre des bluffs — ceux qui sont passés, ceux qui ont été démasqués et par qui, et les buzz tombés à côté.
- **Séquencier** : le journal de la partie, séquence par séquence, avec les vies dépensées et les sorties de plateau.
- **Générique technique** : le décompte de la partie, puis le carton **FIN**.

Le générique est **assemblé en arrière-plan pendant la partie**, sur le temps mort après chaque tour validé : la table ne l’attend jamais. Il défile seul à vitesse de lecture et se passe d’un appui n’importe où sur l’écran (ou Échap, Entrée, Espace) ; il s’efface aussi de lui-même à la fin du rouleau. En mouvement réduit, il devient un document que l’on fait défiler soi-même. L’écran des scores garde un lien pour le revoir.

## Tests

```bash
npm test             # 95 tests unitaires, intégration, données, propriétés et manifeste de modules
npm run test:e2e     # desktop + mobile avec un Chromium reproductible
npm run test:e2e:pages # mêmes parcours sous /Cinefile_beta/
npm run test:all     # totalité de la quality gate
```

Comme l’interface est découpée en modules chargés directement par le navigateur, chaque fichier doit être nommé dans `public/sw.js` et dans `scripts/build-pages.mjs`. `test/module-manifest.test.mjs` parcourt le graphe d’imports depuis `src/main.js` et échoue si l’une des deux listes a divergé — une dérive ne se manifesterait sinon qu’hors connexion, ou en production seulement.

La suite vérifie notamment le moteur de partie, 250 séquences pseudo-aléatoires, la phonétique française du mode vocal, la déduplication, les alias, l’unicité TMDb, les preuves filmographiques, les shards différés, le cache hors ligne, le vocal, le générique de fin, l’export/import, le serveur, la PWA et les parcours critiques sur deux tailles d’écran. GitHub Actions rejoue cette quality gate à chaque push et pull request.

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

- `src/main.js` : amorçage — lecture du déploiement, chargement du snapshot, construction des services.
- `src/ui/` : l’interface. `runtime.js` (état partagé et indirections de rendu), `router.js` (table de routes), `shell.js`, `format.js`, `verification.js`, `link-check.js`, et `ui/screens/` (un module par écran : accueil, setup, partie classique, mode vocal, générique déroulant, scores, profils).
- `src/styles.css` : le système de design complet — jetons, mobilier de pellicule, composants, écrans, mouvement.
- `src/game/engine.js` : règles déterministes et transitions immuables.
- `src/game/credits.js` : relecture du journal de partie en générique — distribution, chaîne et ses preuves filmographiques, registre des bluffs, séquencier.
- `src/game/database.js` : index canonique, alias, liens et recherche.
- `src/game/catalog.js` : recherche hybride et cache navigateur.
- `src/server/` : adaptateurs TMDb, catalogue publié et vérification Wikidata/Wikipédia côté serveur.
- `src/voice/` : capture vocale, phonétique française, résolution d’entités et accumulateur de tour, séparés de l’interface.
- `src/data/` : snapshot, synonymes, registre d’identités revues, overlay TMDb compact, index de portraits, journal de fusion et métriques.
- `scripts/` : reconstruction des données, build Pages et synchronisation incrémentale.
- `test/` et `e2e/` : non-régression logique et navigateur.

Les fichiers minifiés récupérés restent sous `public/assets/` pour audit mais ne sont plus le runtime de l’application. Le dump du propriétaire est conservé sous `recovery/lovable-dump/`.

La progression détaillée et les quelques tâches nécessitant un jeton ou une validation éditoriale figurent dans [roadmap.md](roadmap.md).

## Déploiements

- **GitHub Pages** : `.github/workflows/pages.yml` construit une liste blanche statique compatible avec le sous-chemin du dépôt, génère les filmographies à la demande, teste le jeu et publie `dist/`. Aucun secret ni code serveur n’entre dans l’artefact.
- **Serveur Node** : `npm start` respecte `PORT`, sert le fallback SPA et expose `/api/catalog/*` ainsi que `/api/verify-link`, sans transmettre le jeton TMDb au navigateur. Cette cible est prête pour Railway, Render, Fly.io ou un hébergement équivalent dès qu’une fonction demande un backend permanent.

GitHub Pages est donc un premier hébergement, pas une limite produit : le frontend et le moteur ne dépendent pas de cette plateforme.

### Déployer la pile complète

Le serveur n'a **aucune dépendance d'exécution** et ne demande aucune étape de construction : il sert le dépôt tel quel. Déployer se résume à lancer `node server.mjs` avec un `PORT`.

- **Sans clé TMDb**, la cible Node apporte déjà ce que Pages ne peut pas faire : la cascade de vérification interroge réellement Wikidata puis Wikipédia, avec ses preuves, ses durées et l'étape qui a trouvé le film. Les filmographies sont servies par l'overlay publié.
- **Avec `TMDB_API_TOKEN`**, s'ajoute la recherche des artistes absents du snapshot de 1 523 identités — le cas « je prononce un nom que le catalogue ignore » — et l'étape TMDb de la cascade, la plus rapide et la mieux structurée.

Deux fichiers rendent l'opération immédiate : `render.yaml` (bouton *Deploy to Render*, plan gratuit, aucune ligne de commande) et un `Dockerfile` de sept lignes utilisable tel quel sur Cloud Run, Railway, Koyeb ou Fly. Le jeton reste côté serveur dans tous les cas; le navigateur ne le voit jamais. Le serveur charge le catalogue publié à la première requête API : comptez environ 200 Mo de mémoire résidente, donc 512 Mo d'instance au minimum.

### Faire emprunter l'API par la version Pages

Une fois une instance Node déployée, l'édition statique peut lui emprunter son catalogue et sa cascade de vérification, sans jamais approcher le jeton.

- Côté serveur, `ALLOWED_ORIGINS` déclare qui a le droit d'emprunter, par exemple `https://napolocreed.github.io`. Les en-têtes CORS ne couvrent que `/api/*`, et une origine non déclarée est refusée : cette API donne accès à un jeton TMDb limité et à une cascade Wikidata/Wikipédia qui tourne sous sa propre identité, ce n'est pas un relais public.
- Côté dépôt, la variable `API_BASE_URL` (Settings → Variables, pas un secret : l'origine est publique) est estampillée dans le build Pages. Variable absente, l'artefact est exactement celui d'aujourd'hui.

L'édition qui emprunte annonce clairement son état — « Catalogue emprunté · TMDb en direct » — et retombe intégralement sur le catalogue embarqué dès que l'origine ne répond plus ou que l'appareil est hors connexion.

### Agrandir le catalogue embarqué

`npm run import:cast` (workflow *Import TMDb cast*, déclenchement manuel avec un budget) ajoute au snapshot les artistes qu'il ignore, en partant des distributions des films français populaires. C'est le seul moyen pour la cible Pages hors connexion de connaître un artiste : elle ne peut interroger personne. Mesure de départ : sur 102 noms contemporains, 89 sont déjà présents; les 13 manquants sont la génération 2010-2025 et les humoristes passés au cinéma. L'import n'ajoute jamais un doublon — il filtre par identifiant TMDb puis par nom normalisé — et n'écrit rien quand il n'a rien trouvé de neuf.

Les données et portraits enrichis proviennent de TMDb. This product uses the TMDB API but is not endorsed or certified by TMDB.
