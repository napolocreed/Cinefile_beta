# Ciné-Fil — feuille de route

Cette feuille de route décrit les évolutions prévues après la reconstruction du jeu. Elles ne sont pas implémentées dans la version actuelle ; le socle actuel privilégie la fidélité au jeu public, une base locale déterministe et des tests de non-régression.

## Socle livré

- Reconstruction autonome des écrans accueil, configuration, partie, bluff, résultats et profils.
- Refonte visuelle **Old School Hollywood** : générique, pellicule, studio, typographie éditoriale, or patiné et rouge cinéma.
- Moteur de jeu indépendant de l’interface : chaînes, acteurs déjà utilisés, vies, scores, séries, défis, éliminations et chronomètre.
- Base récupérée de 1 524 acteurs et 42 336 films, avec normalisation des accents et de la ponctuation.
- Persistance locale et idempotente des parties, historiques, profils et succès.
- Tests automatisés de la base, du moteur, du stockage et du serveur SPA.

## Phase 1 — fiabiliser la connaissance cinéma

1. **Enrichissement de la base**
   - Croiser les sources publiques et les API autorisées.
   - Conserver les identifiants externes, titres originaux, titres localisés, années, types d’œuvre et crédits.
   - Distinguer acteurs, réalisateurs, scénaristes, compositeurs et caméos pour préparer les variantes de règles.

2. **Déduplication**
   - Dédupliquer les personnes par identifiant externe, puis par rapprochement nom/date de naissance.
   - Dédupliquer les films par identifiant, titre et année.
   - Conserver un journal des fusions et une possibilité de revenir sur une décision automatique.

3. **Dictionnaires de synonymes**
   - Accents, apostrophes, tirets, translittérations et ordre prénom/nom.
   - Titres français, titres originaux, titres abrégés et variantes courantes.
   - Noms d’usage et alias avec score de confiance, sans rendre les faux positifs silencieux.

## Phase 2 — saisie sans friction

- Étendre l’autocomplétion à **tous les artistes** présents dans la base, et non seulement au sous-ensemble actuellement embarqué.
- Mettre en place une recherche hybride : index local instantané puis API distante pour les artistes absents.
- Afficher une proposition de désambiguïsation quand plusieurs artistes ou œuvres correspondent.
- Ajouter une validation explicite et lisible lorsqu’un nom est accepté par vote plutôt que par la base.
- Prévoir un mode hors-ligne dégradé avec cache local et indicateur de fraîcheur des données.

## Phase 3 — couverture filmographique maximale

- Intégrer TMDb et/ou Allociné selon les droits, quotas, coûts et conditions de redistribution.
- Construire une synchronisation incrémentale plutôt qu’un téléchargement complet à chaque partie.
- Prioriser les chemins réellement jouables : acteurs populaires, cinéma français, œuvres récentes et passerelles entre communautés de films.
- Ajouter des métriques de couverture : taux de liens trouvés, films orphelins, acteurs sans passerelle, ambiguïtés par langue.
- Versionner les snapshots de données afin qu’une partie reste rejouable avec la base qui l’a validée.

## Phase 4 — mode vocal passif

Le mode vocal sera une variante dédiée, avec une interface volontairement réduite :

- deux sections d’écoute, une par joueur, avec timer individuel ;
- détection continue des noms prononcés, sans bouton « valider » à chaque réplique ;
- propositions candidates classées lorsqu’un nom est incertain ;
- buzzer « bluff » central, accessible pendant la fenêtre de décision ;
- après le buzzer, sélection des deux derniers noms parmi les propositions détectées ;
- validation visuelle de la chaîne et possibilité de corriger une reconnaissance avant résolution ;
- séparation stricte entre capture audio, transcription, résolution d’entités et moteur de jeu ;
- consentement micro explicite, indicateur d’écoute, arrêt immédiat et fonctionnement dégradé si le micro ou le réseau disparaît.

## Phase 5 — qualité produit

- Tests navigateur sur mobile et desktop pour chaque route et chaque transition critique.
- Tests de propriété du moteur : une chaîne ne contient jamais deux fois le même acteur normalisé ; un joueur éliminé ne reprend jamais la main ; une partie terminée ne change plus.
- Tests de données sur des snapshots versionnés.
- Instrumentation locale facultative des erreurs, sans collecte par défaut.
- Accessibilité clavier, lecteurs d’écran, contrastes, réduction des animations et grands caractères.
- Export/import local d’une partie pour jouer entre appareils sans compte.
