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

Le secret reste côté serveur ou dans les secrets GitHub Actions. L’interface ne reçoit jamais la clé : le navigateur passe par `/api/*`, jamais par TMDb.

Reproduire le snapshot canonique :

```bash
npm run build:data
```

Lancer une vague incrémentale TMDb, reprenable après interruption :

```bash
npm run sync:tmdb:env -- --limit=100
```

La sortie locale `src/data/tmdb-overlay.local.json` est ignorée par Git afin qu’une synchronisation soit contrôlée avant intégration. Le fichier publié `src/data/tmdb-overlay.json` utilise un schéma compact et référentiel; les homonymes ne sont acceptés qu’avec un recouvrement filmographique décisif.

Pour les rafraîchissements automatiques, créer dans GitHub `Settings → Secrets and variables → Actions` un secret de dépôt nommé `TMDB_API_TOKEN`. Le workflow `Enrich TMDb catalogue` rafraîchit ensuite le catalogue par lots de 100, rejoue les tests et pousse le résultat sur `main` — d’où il repart dans le circuit ordinaire : quality gate, puis déploiement Cloud Run. Le jeton ayant été partagé hors du gestionnaire de secrets, le renouveler avant cette configuration est recommandé.

Le navigateur ne charge jamais l’overlay complet : il reçoit le snapshot embarqué, puis la filmographie enrichie du seul artiste sélectionné, servie par `/api/catalog/people/*`. Ce qui a été consulté reste jouable hors connexion.

### Vérification universelle et VAR

Lorsqu’un bluff porte sur un lien absent du catalogue chargé, la cible Node consulte une cascade sans LLM : TMDb, Wikidata/QLever avec repli WDQS, puis Wikipédia en français et en anglais. Le contrat distingue quatre résultats :

- `CONFIRMED` : une œuvre structurée commune a été retrouvée ;
- `PROBABLE` : une page de film contient les deux noms, sans preuve structurée suffisante ;
- `NOT_FOUND` : toutes les sources disponibles ont répondu sans résultat ;
- `UNKNOWN` : réseau, quota, timeout ou surcharge empêchent de conclure.

La cascade rend compte d’elle-même : chaque réponse liste ses étapes dans l’ordre — base Ciné-Fil, TMDb, Wikidata, Wikipédia — avec leur issue (preuve, indice, rien trouvé, injoignable, inutile, abandonnée) et leur durée. L’écran de VAR affiche cette chronologie et met en évidence l’étape qui a produit la preuve, de sorte que la table voit d’où vient le verdict, ou que personne n’a rien trouvé.

Seul `CONFIRMED` tranche automatiquement. Tous les autres états ouvrent une salle **VAR** avec les indices disponibles, des liens de recherche et une décision humaine. Une absence de résultat n’est donc jamais assimilée à la preuve qu’un film n’existe pas.

Les confirmations positives enrichissent `cinefil.verification-cache.v1` sur l’appareil et deviennent immédiatement rejouables hors connexion. Les résultats négatifs ne sont jamais appris. Hors connexion, aucune source n’est interrogée et le verdict reste `UNKNOWN` : la VAR humaine et ses recherches externes restent disponibles. Définir `VERIFY_LINK_NETWORK=0` désactive également la cascade côté serveur sans casser le jeu.

Le cadrage, les alternatives étudiées et les écarts assumés sont consignés dans [le rapport de fallback universel](docs/rapport-fallback-universel.md).

## Profils, statistiques et succès

L'écran Profils est le seul de l'application qui a le droit de charger : on vient y lire, pas y jouer. Une carte montre quatre compteurs et trois jauges ; tout le reste vit dans un repli.

- **Les trois jauges** disent ce qu'aucun total ne dit : taux de bluffs réussis, fiabilité au buzzer, tenue de table. Chacune porte sa fraction sous le pourcentage, et **aucune n'affiche de chiffre sous son socle** — cinq bluffs, cinq buzz, trois parties. Un tiret est une réponse ; un « 100 % » obtenu sur un essai n'en est pas une.
- **La fiche complète** déplie quatre sections : le palmarès (place moyenne, séries, points, niveau), le style de jeu (tours joués, réussite au tour, occasions de buzzer contre buzz déclenchés), la bobine (acteur fétiche, film le plus revu, la tête qui ne passe pas, plus longue chaîne, durée moyenne, séance de prédilection) et la table (bande de forme sur dix parties, partenaire fidèle, bête noire, victime préférée).
- **Deux libellés étaient faux et sont corrigés** : `bluffsCaught` compte les fois où l'on s'est *fait* démasquer — c'est « Bluffs sanctionnés » ; démasquer quelqu'un, c'est `challengesSuccessful`, désormais « Bluffs démasqués ». L'ancien succès qui récompensait cinquante bluffs subis a disparu avec le reste.
- **Ce qui vient de l'historique est daté** : les cinquante dernières parties, jamais « depuis toujours », et c'est écrit sous la section.
- **Cinquante succès** en quatre familles (carrière, exploits de partie, bluff et enquête, cinéphilie) et quatre paliers, dont cinq secrets et quinze à progression mesurable. Chacun se prononce sur **un joueur** — les six précédents jugeaient la partie, si bien que toute la table recevait le même carton. Une partie de moins de six actes ou six acteurs n'en décroche aucun.
- Les nouveaux compteurs démarrent à la partie suivante pour une fiche antérieure ; ces lignes affichent un tiret et le disent, plutôt que des zéros qui se liraient comme des résultats.

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
npm run test:all     # totalité de la quality gate
```

Comme l’interface est découpée en modules chargés directement par le navigateur, chaque fichier doit être nommé dans la liste de cache de `public/sw.js`. `test/module-manifest.test.mjs` parcourt le graphe d’imports depuis `src/main.js` et échoue si la liste a divergé — une dérive ne se manifesterait sinon qu’hors connexion, sur un appareil ayant déjà installé le jeu.

La suite vérifie notamment le moteur de partie, 250 séquences pseudo-aléatoires, la phonétique française du mode vocal, la déduplication, les alias, l’unicité TMDb, les preuves filmographiques, les shards différés, le cache hors ligne, le vocal, le générique de fin, l’export/import, le serveur, la PWA et les parcours critiques sur deux tailles d’écran. GitHub Actions rejoue cette quality gate à chaque push et pull request, et c'est sa réussite sur `main` qui déclenche le déploiement.

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
- `scripts/` : reconstruction des données, import de distributions et synchronisation incrémentale.
- `test/` et `e2e/` : non-régression logique et navigateur.

Les fichiers minifiés récupérés restent sous `public/assets/` pour audit mais ne sont plus le runtime de l’application. Le dump du propriétaire est conservé sous `recovery/lovable-dump/`.

La progression détaillée et les quelques tâches nécessitant un jeton ou une validation éditoriale figurent dans [roadmap.md](roadmap.md).

## Déploiements

Le jeu a une seule cible : **son propre serveur Node**, déployé sur Cloud Run. `npm start` respecte `PORT`, sert le fallback SPA et expose `/api/catalog/*` ainsi que `/api/verify-link`, sans jamais transmettre le jeton TMDb au navigateur.

L'édition GitHub Pages a été retirée : elle ne pouvait ni interroger TMDb, ni faire tourner la cascade de vérification, et obligeait le code à porter deux catalogues. **Le hors-ligne, lui, n'a pas bougé** — il n'a jamais dépendu de Pages : le snapshot embarqué, le cache de filmographies, les liens confirmés et le service worker restent en place, et une partie se joue toujours entière sans réseau.

### Déployer la pile complète

Le serveur n'a **aucune dépendance d'exécution** et ne demande aucune étape de construction : il sert le dépôt tel quel. Déployer se résume à lancer `node server.mjs` avec un `PORT`.

- **Sans clé TMDb**, la cascade de vérification interroge réellement Wikidata puis Wikipédia, avec ses preuves, ses durées et l'étape qui a trouvé le film. Les filmographies sont servies par l'overlay publié.
- **Avec `TMDB_API_TOKEN`**, s'ajoute la recherche des artistes absents du snapshot de 1 523 identités — le cas « je prononce un nom que le catalogue ignore » — et l'étape TMDb de la cascade, la plus rapide et la mieux structurée.

Un `Dockerfile` de sept lignes est utilisable tel quel sur Cloud Run, Railway, Koyeb ou Fly, et `render.yaml` donne un déploiement Render en un bouton. Le jeton reste côté serveur dans tous les cas ; le navigateur ne le voit jamais. Le serveur charge le catalogue publié à la première requête API : comptez environ 200 Mo de mémoire résidente, donc 512 Mo d'instance au minimum.

La page servie porte le tampon de la révision qui l'a produite : `K_REVISION` sur Cloud Run, `BUILD_STAMP` ailleurs. C'est ce que l'écran Profils affiche sous « Version publiée », de sorte qu'« est-ce que mon déploiement est en ligne ? » se répond en regardant la page.

### Déploiement continu sur Cloud Run

`.github/workflows/cloud-run.yml` remet le service en ligne **à chaque `main` qui passe la quality gate** — pas à chaque push : ce service sert l'API de vérification, un `main` rouge n'a rien à y faire. Le projet `cinefile-505500` est en dur ; le workflow reste inerte tant qu'aucune authentification n'est déclarée, et se relance à la main depuis l'onglet Actions (*Deploy Cloud Run* → *Run workflow*). Chaque déploiement se termine par une sonde sur `/api/catalog/status` : une révision qui ne répond pas fait échouer le job.

Deux garde-fous méritent d'être connus, parce qu'ils protègent un service déjà réglé à la main :

- **Le service n'est pas deviné.** Un nom inventé ne provoque pas d'erreur : il crée un second service à côté du vrai et le déploiement se déclare vert. Le workflow lit donc les services du projet ; s'il n'y en a qu'un, c'est celui-là, région comprise. S'il y en a plusieurs, il s'arrête et demande de nommer la cible (`CLOUD_RUN_SERVICE`, `GCP_REGION`).
- **Les réglages existants survivent.** Le déploiement utilise `--update-env-vars`, jamais `--set-env-vars` : « set » remplacerait tout le jeu de variables du service et effacerait le `TMDB_API_TOKEN` posé dans la console. Ce qui n'est pas configuré dans le dépôt n'est simplement pas envoyé à `gcloud`.

**Mise en place, une fois.** Le mode recommandé est la fédération d'identité : GitHub échange un jeton OIDC de courte durée, aucune clé ne dort dans le dépôt.

```bash
PROJECT_ID=cinefile-505500
REPO=napolocreed/Cinefile_beta

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com iamcredentials.googleapis.com

# Le compte de service qui déploie, et le strict nécessaire pour construire puis publier une révision.
gcloud iam service-accounts create github-deploy --display-name "Déploiement GitHub Actions"
SA="github-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
for ROLE in roles/run.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin \
            roles/storage.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$ROLE"
done

# La fédération, restreinte à ce dépôt : aucun autre dépôt ne peut emprunter cette identité.
gcloud iam workload-identity-pools create github --location global --display-name GitHub
gcloud iam workload-identity-pools providers create-oidc github \
  --location global --workload-identity-pool github --display-name "GitHub Actions" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository == '${REPO}'"

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format 'value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

echo "GCP_WIF_PROVIDER = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/github"
```

**Réglages du dépôt** (Settings → Secrets and variables → Actions → *Variables*) :

| Variable | Rôle |
| --- | --- |
| `GCP_WIF_PROVIDER` | **Requise.** Le chemin affiché par la dernière commande ci-dessus. Vide, le workflow ne s'exécute pas. |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `github-deploy@cinefile-505500.iam.gserviceaccount.com`. |
| `CLOUD_RUN_SERVICE`, `GCP_REGION` | Inutiles tant que le projet n'héberge qu'un seul service : il est reconnu tout seul. |
| `CLOUD_RUN_ALLOWED_ORIGINS` | Normalement inutile : le jeu est servi par ce même service. À ne remplir que si une autre origine doit appeler `/api/*`. |
| `CLOUD_RUN_ENV_VARS` | Réglages supplémentaires, `CLE=valeur##AUTRE=valeur`. Les variables déjà posées sur le service ne sont pas touchées. |
| `CLOUD_RUN_TMDB_SECRET` | Le jour où le jeton TMDb passera de variable d'environnement à secret managé, nommer ici le secret Secret Manager. |
| `CLOUD_RUN_ALLOW_UNAUTHENTICATED` | `true` pour (re)forcer l'ouverture publique du service. Par défaut, l'exposition du service n'est pas touchée. |
| `GCP_DEPLOY_WITH_KEY` | `true` pour utiliser le secret `GCP_SA_KEY` (JSON d'un compte de service) au lieu de la fédération. |

Le jeton TMDb vit aujourd'hui dans le service, en variable d'environnement `TMDB_API_TOKEN` : le déploiement ne le lit pas, ne l'écrit pas et ne l'efface pas. La sonde de fin signale simplement, sans faire échouer le job, si le service répond `configured: false` — c'est-à-dire s'il tourne sans jeton.

### Agrandir le catalogue embarqué

`npm run import:cast` (workflow *Import TMDb cast*, déclenchement manuel avec un budget) ajoute au snapshot les artistes qu'il ignore, en partant des distributions des films français populaires. C'est le seul moyen pour un appareil hors connexion de connaître un artiste : il ne peut interroger personne. Mesure de départ : sur 102 noms contemporains, 89 sont déjà présents; les 13 manquants sont la génération 2010-2025 et les humoristes passés au cinéma. L'import n'ajoute jamais un doublon — il filtre par identifiant TMDb puis par nom normalisé — et n'écrit rien quand il n'a rien trouvé de neuf.

Les données et portraits enrichis proviennent de TMDb. This product uses the TMDB API but is not endorsed or certified by TMDB.
