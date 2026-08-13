# Rapport de recherche — Fallback universel de vérification « film commun »

> **Destinataire** : le prochain modèle/développeur qui implémentera la fonctionnalité.
> **Date** : 2026-08-12 · **Branche** : `claude/fallback-film-search-3ptxt4`
> **Objet** : en cas d'échec de la base locale **et** de TMDb, disposer d'un fallback quasi universel, **sans LLM**, pour vérifier qu'un film commun existe entre deux artistes — plus un bouton « VAR » de vérification manuelle en dernier recours.
> **Statut initial** : recherche et cadrage. **Mise en œuvre le 13 août 2026** sur `agent/universal-verification-fallback`.

## État de l’implémentation

Le rapport ci-dessous est conservé comme document de recherche. L’implémentation finale en reprend la cascade tout en corrigeant plusieurs hypothèses :

- `GET /api/verify-link` interroge TMDb lorsqu’il est configuré, puis Wikidata via QLever avec repli WDQS, et enfin Wikipédia fr/en ;
- l’endpoint QLever public validé est `https://qlever.dev/api/wikidata` et exige des déclarations `PREFIX` explicites ;
- les candidats Wikidata sont d’abord filtrés sur l’égalité normalisée du libellé afin d’écarter les pages seulement apparentées au nom recherché ;
- une intersection structurée produit `CONFIRMED`, une cooccurrence dans une page Wikipédia ne produit que `PROBABLE` et exige donc toujours une décision humaine ;
- `NOT_FOUND` n’est jamais interprété comme la preuve d’une absence : l’interface ouvre une salle VAR avec indices, recherches externes et trois issues explicites ;
- seules les confirmations positives enrichissent durablement le cache navigateur `cinefil.verification-cache.v1`, inclus dans l’export/import ;
- les timeouts, erreurs, quotas et surcharges aboutissent à `UNKNOWN` sans bloquer la partie ; les appels amont concurrents sont bornés ;
- GitHub Pages reste entièrement statique et ouvre directement la VAR humaine. La cascade automatisée nécessite la cible Node ;
- l’index IMDb local n’est pas implémenté : son coût d’hébergement et sa licence doivent d’abord être justifiés par des mesures réelles de liens manquants.

---

## 1. Contexte : où le fallback s'insère dans le code actuel

Points établis en explorant le dépôt (à jour sur cette branche) :

- Le cœur de la validation est `sharedWorks()` / `sharedFilms()` dans `src/game/database.js:244-250` et `:313`. Le moteur appelle `database.sharedFilms(previousActor, proposedActor, …)` dans `src/game/engine.js:146`. Si l'un des deux artistes est inconnu de la base, le coup passe en `method: "vote"` (`engine.js:155`) — c'est **exactement le trou que le fallback doit combler** avant de retomber sur le vote humain.
- **L'intégration TMDb est déjà entièrement codée** (contrairement à ce que suggérait l'énoncé « en cours ») : client serveur `src/server/tmdb.js`, endpoints `GET /api/catalog/*` dans `server.mjs:31-76`, catalogue hybride `src/game/catalog.js`, script d'enrichissement `scripts/sync-tmdb.mjs`. Elle est simplement **inactive faute de jeton** (`TMDB_API_TOKEN`, cf. `roadmap.md` l.40). Le « fallback 1 » est donc un problème de configuration, pas de développement.
- Base locale : 1 524 personnes, 41 914 œuvres, 84 501 crédits, aucun `externalIds` renseigné — clairement insuffisante, comme constaté.
- Contraintes d'architecture à respecter : serveur Node ≥ 20.6 sans framework ni dépendance runtime, tous les appels externes **côté serveur uniquement** (les clés ne quittent jamais le serveur, pas de CORS), cache HTTP + LRU déjà en place comme modèle (`src/server/tmdb.js:9`), PWA jouable hors ligne (le fallback ne fonctionne qu'en ligne → le vote reste le filet ultime).

**Note d'environnement** : le sandbox de rédaction de ce rapport bloque le réseau sortant (proxy d'egress), les appels d'API ci-dessous n'ont donc **pas pu être exécutés en live ici**. Ils suivent la documentation officielle vérifiée (sources en §10) et chaque piste inclut une commande `curl` prête à lancer pour validation en local — c'est la première chose à faire avant d'implémenter.

### Principe conceptuel important : l'asymétrie de la certitude

Un fallback peut prouver qu'un lien **existe** (on a trouvé le film → certitude positive, sans LLM). Il ne peut jamais prouver qu'un lien **n'existe pas** (absence de résultat ≠ inexistence). La conception doit donc produire des niveaux de confiance, jamais un « non » définitif :

| Verdict | Signification | Action jeu |
|---|---|---|
| `CONFIRMED` | Film commun trouvé avec titre + source | Coup validé, preuve affichable |
| `NOT_FOUND` | Toute la cascade a répondu sans rien trouver | Fort soupçon de bluff → buzz/vote éclairé + bouton VAR |
| `UNKNOWN` | Cascade indisponible (offline, timeout, quota) | Vote humain (comportement actuel) |

---

## 2. Vue d'ensemble de la cascade recommandée

```
Niveau 0  Base locale (existant)                     — instantané, offline
Niveau 1  TMDb (déjà codé, activer le jeton)         — ~200 ms, très bonne couverture ciné mondial
Niveau 2  Wikidata SPARQL                            — ~300 ms-2 s, gratuit, sans clé  ← RECOMMANDÉ
Niveau 3  Recherche plein-texte Wikipédia fr+en      — ~300 ms, gratuit, sans clé      ← RECOMMANDÉ
Niveau 4  (option) Index local IMDb Datasets         — offline, quasi exhaustif, licence à vérifier
Niveau 5  Bouton « VAR » : liens de recherche web    — zéro API, universel, jugement humain
```

Les niveaux 2 et 3 réalisent ensemble l'idée initiale (« chercher les deux artistes + film et détecter une page de film dans les résultats ») mais sur des corpus **interrogeables gratuitement, sans clé, avec une classification 100 % déterministe** (données structurées ou motifs d'URL), là où les APIs des moteurs de recherche généralistes sont devenues impraticables en 2026 (démonstration en §6).

---

## 3. Niveau 2 — Wikidata SPARQL : le fallback structurel

### Pourquoi c'est le meilleur candidat

- **Gratuit, sans clé, sans quota payant** ; seule exigence : un en-tête `User-Agent` identifiant l'application (ex. `CineFil/1.0 (https://github.com/napolocreed/Cinefile_beta; contact)`) et le respect des `429`.
- La question « quels films ont X **et** Y au générique ? » est une **requête native**, pas une heuristique : propriété `P161` (cast member) et consœurs.
- Couvre au-delà des acteurs : réalisateurs (`P57`), scénaristes (`P58`), compositeurs (`P86`), producteurs (`P162`), directeurs photo (`P344`), monteurs (`P1040`) — pertinent puisque le jeu parle d'« artistes », et TMDb `combined_credits` couvre aussi le crew.
- Multilingue nativement (labels fr avec repli en) — aligne avec `locale: fr-FR` du client TMDb existant.

### Pipeline en 2 appels

**Étape A — résoudre chaque nom en identifiants Wikidata (QID)** :

```bash
curl -s -H 'User-Agent: CineFil/1.0 (contact)' \
  'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=Jean%20Dujardin&language=fr&uselang=fr&type=item&limit=5&format=json'
```

Retourne des candidats classés `{id: "Q...", label, description}`. Garder les 3-5 premiers **sans choisir** : l'étape B lève l'ambiguïté d'elle-même.

**Étape B — intersection SPARQL sur toutes les paires de candidats** (gère les homonymes gratuitement : si une paire quelconque partage un film, c'est la réponse) :

```sparql
SELECT DISTINCT ?film ?filmLabel ?year ?l ?r WHERE {
  VALUES ?l { wd:QID_G1 wd:QID_G2 wd:QID_G3 }   # candidats artiste gauche
  VALUES ?r { wd:QID_D1 wd:QID_D2 }             # candidats artiste droite
  VALUES ?pl { wdt:P161 wdt:P57 wdt:P58 wdt:P86 wdt:P162 }
  VALUES ?pr { wdt:P161 wdt:P57 wdt:P58 wdt:P86 wdt:P162 }
  ?film ?pl ?l ; ?pr ?r ;
        wdt:P31/wdt:P279* wd:Q11424 .           # instance de film (inclut téléfilm, court-métrage…)
  OPTIONAL { ?film wdt:P577 ?d . BIND(YEAR(?d) AS ?year) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
} LIMIT 20
```

```bash
curl -s -G -H 'User-Agent: CineFil/1.0 (contact)' -H 'Accept: application/sparql-results+json' \
  'https://query.wikidata.org/sparql' --data-urlencode query@requete.rq
```

Réponse JSON standard (`results.bindings[].filmLabel.value`) → verdict `CONFIRMED` avec titre, année et paire de QID (à **persister dans l'overlay** pour enrichir la base locale, cf. §8).

Variante élargie : remplacer `wd:Q11424` par `wd:Q2431196` (« œuvre audiovisuelle ») pour inclure les séries si les règles du jeu l'acceptent un jour — la base locale filtre aujourd'hui `type === "movie"` (`database.js:249`).

### Limites et parades

| Limite | Détail | Parade |
|---|---|---|
| `P161` souvent incomplet | Wikidata liste surtout les rôles principaux ; un second rôle obscur peut manquer | Niveau 3 (texte Wikipédia) attrape la « Distribution » complète des articles |
| Quotas WDQS | 60 s de temps de calcul/min par IP+UA, 5 requêtes parallèles max, bannissement si on ignore les `429` | Cache serveur agressif (la requête est déterministe), backoff, une seule requête par validation |
| Latence/disponibilité WDQS variable | Timeout 60 s possible sur le service public | Timeout client court (5-8 s) puis niveau suivant ; endpoint alternatif **QLever** ci-dessous |
| Homonymes | « Michel Blanc » a plusieurs QID | Résolu par le VALUES multi-candidats ci-dessus |

**Endpoint alternatif QLever** (`https://qlever.dev/api/wikidata`) : moteur SPARQL très rapide sur le dump Wikidata complet, gratuit, sans clé ; Wikimedia a d'ailleurs engagé en 2025-2026 la **migration du backend officiel WDQS vers QLever**. Fraîcheur des données légèrement décalée (dump), largement suffisante ici. Bon candidat d'endpoint primaire avec WDQS en secours (ou l'inverse).

---

## 4. Niveau 3 — Recherche plein-texte Wikipédia : l'idée « recherche Google », en version fiable

C'est la traduction directe de l'idée initiale — chercher `"artiste 1" "artiste 2"` et détecter une page de film dans les premiers résultats — mais sur l'API MediaWiki : gratuite, sans clé, stable, et surtout la classification « est-ce un film ? » y est **déterministe** (données structurées, zéro NLP).

**Étape A — recherche des deux noms en phrases exactes** (frwiki, puis enwiki en repli) :

```bash
curl -s -H 'User-Agent: CineFil/1.0 (contact)' \
  'https://fr.wikipedia.org/w/api.php?action=query&list=search&srsearch=%22Jean%20Dujardin%22%20%22B%C3%A9r%C3%A9nice%20Bejo%22&srlimit=10&format=json'
```

Force du procédé : les articles Wikipédia de films contiennent une section « Distribution » souvent **exhaustive** — un film commun absent de Wikidata `P161` et de TMDb sera quand même trouvé si les deux noms figurent dans l'article. C'est la couche qui rend l'ensemble « quasi absolu » pour le cinéma francophone notamment.

**Étape B — classifier chaque résultat sans LLM.** Pour les 5-10 premiers titres, une seule requête groupée récupère l'entité Wikidata liée :

```bash
curl -s -H 'User-Agent: CineFil/1.0 (contact)' \
  'https://fr.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&titles=The%20Artist%7COSS%20117&format=json'
```

puis vérifier `P31 = film` sur ces entités (un `wbgetclaims`, ou le même SPARQL qu'en §3 avec `VALUES`). Repli encore plus simple, sans second appel : `prop=categories` et motif `^Film…` sur les catégories frwiki (`Film français sorti en 2011`, etc.) — c'est le « NLP simple backend » évoqué, réduit à une regex.

**Prudence** : la cooccurrence des deux noms dans un article de film ne garantit pas qu'ils y **jouent** tous les deux (l'un peut être cité en anecdote). Deux postures possibles :
- verdict `CONFIRMED` seulement si le niveau 2 ou la fiche structurée confirme, le niveau 3 ne produisant que `PROBABLE` (affiché comme preuve à voter) ;
- ou `CONFIRMED` si les deux noms apparaissent dans la section Distribution (parsing du wikitexte de la section — encore une regex, mais plus fragile).

La première posture est recommandée : elle reste 100 % déterministe et honnête sur la confiance.

Limites : exige la notoriété Wikipédia du film (les niveaux 1-2-4 couvrent le reste) ; politique User-Agent et courtoisie de rythme (les limites anonymes de l'Action API sont larges pour cet usage, avec cache serveur).

---

## 5. Niveau 4 (option) — Index local IMDb Datasets : le « quasi absolu » hors ligne

IMDb publie des dumps TSV quotidiens, téléchargeables librement (`https://datasets.imdbws.com/`) : `name.basics` (personnes), `title.basics` (œuvres + `titleType`), `title.principals` (casting/crew par œuvre). Un script (type `scripts/sync-tmdb.mjs`) peut construire une **SQLite locale filtrée** (films uniquement, index `nconst→tconst`), rafraîchie par cron hebdomadaire : intersection de deux filmographies en < 1 ms, zéro réseau, zéro quota, couverture des films les plus obscurs.

**Réserves sérieuses — à arbitrer avant d'implémenter :**

1. **Licence non-commerciale uniquement** (IMDb Non-Commercial Licensing). CinéFil est aujourd'hui un jeu local gratuit → a priori compatible, mais toute évolution commerciale l'interdirait. Attribution IMDb requise. À faire valider comme la piste Allociné (`roadmap.md` l.41).
2. **`title.principals` est plafonné à ~10 « principals » par titre** (contrairement à l'ancien format LIST complet) : un 15ᵉ rôle n'y figure pas. Pour un jeu portant sur des artistes notables, le top-10 du générique couvre l'immense majorité des coups, mais le « quasi absolu » est à nuancer.
3. **Volumétrie et hébergement** : plusieurs centaines de Mo compressés, quelques Go décompressés avant filtrage. Le filesystem Railway est éphémère → volume persistant ou reconstruction au déploiement. C'est le vrai coût de cette piste.
4. Appariement par nom (pas de QID) : réutiliser `normalizeText`/`strictIdentityKey` de `src/game/identity.js`, comme le fait déjà `sync-tmdb.mjs:35`.

Verdict : **excellent rapport couverture/fiabilité, coût d'infrastructure non nul**. À n'implémenter que si les niveaux 1-3 laissent encore trop de trous en pratique (à mesurer, cf. §8 télémétrie).

---

## 6. Moteurs de recherche généralistes : état des lieux 2026 (spoiler : impasse programmatique)

L'idée initiale visait une recherche Google automatisée. Vérification faite, **toutes les voies d'API officielles se sont refermées** :

| Service | État vérifié (août 2026) |
|---|---|
| Google Custom Search JSON API | **Fermée aux nouveaux clients, dépréciation totale annoncée au 1ᵉʳ janvier 2027.** Impasse. |
| Bing Web Search API | **Retirée** (août 2025), remplacée par des offres IA Azure. |
| Brave Search API | Palier gratuit supprimé début 2026 pour les nouveaux comptes ; ~5 $/1 000 requêtes. |
| DuckDuckGo | Aucune API web officielle ; scraping HTML contraire aux CGU, cassant, IP vite bloquée. |
| SerpAPI / Serper / etc. | Fonctionnels mais payants (scraping de Google « as a service », zone grise juridique). |
| SearXNG auto-hébergé | Gratuit mais fragile (blocages amont), une brique de plus à opérer. Non recommandé ici. |

Conclusion : en couche **programmatique**, les moteurs généralistes sont dominés sur toute la ligne par Wikidata/Wikipédia (gratuits, stables, structurés). En revanche, en couche **humaine** (lien cliquable), ils restent imbattables et gratuits → c'est le bouton VAR, §7.

Si un jour une API de recherche est tout de même branchée (ex. budget Serper), la détection « c'est un film » sans LLM reste triviale par **motifs d'URL** dans les résultats — déterministe, zéro NLP :

```
allocine.fr/film/fichefilm_gen_cfilm=\d+\.html   → film, certain
themoviedb.org/movie/\d+                          → film, certain
imdb.com/title/tt\d+                              → œuvre (type à confirmer via datasets/TMDb)
senscritique.com/film/                            → film, certain
fr.wikipedia.org/wiki/…                           → classifier via §4-B
```

**Allociné** : pas d'API publique officielle ; les wrappers non officiels sont fragiles et juridiquement douteux — la roadmap (l.41) prévoit déjà une validation juridique avant toute intégration. À laisser en attente ; le motif d'URL ci-dessus suffit pour l'exploiter passivement dans le VAR.

---

## 7. Bouton « VAR » : la vérification humaine en dernier recours

Quand la cascade répond `NOT_FOUND`/`UNKNOWN`, afficher — automatiquement ou sur demande — de quoi trancher en 10 secondes :

1. **Liens de recherche externes** (zéro API, zéro quota, universel — ouverture dans un nouvel onglet) :
   - `https://www.google.com/search?q=%22{A}%22+%22{B}%22+film`
   - `https://duckduckgo.com/?q=%22{A}%22+%22{B}%22+film` · `https://www.qwant.com/?q=…` (option franco-européenne)
   - `https://www.imdb.com/search/name/?name={A}` / recherche Allociné publique.
   - **Impossible d'embarquer les résultats Google en iframe** (X-Frame-Options/CSP côté Google) et le scraping est exclu : le lien sortant est la seule voie propre — et c'est celle que l'énoncé envisageait (« ou un lien vers la recherche »).
2. **Preuves internes déjà récoltées** par la cascade, affichables en modale sans quitter le jeu : meilleurs résultats de la recherche Wikipédia (titres + extraits `snippet` fournis par l'API + lien), fiches TMDb des deux artistes côte à côte. C'est un vrai « affichage des premiers résultats de recherche », mais depuis des sources qu'on a le droit de réafficher.
3. Le vote existant (`method: "vote"`) reste l'arbitrage final ; le VAR ne fait que l'éclairer. Prévoir l'issue « le buzzé avait raison » → **écrire le lien confirmé dans l'overlay** pour que la base apprenne (mécanisme `exportOverlay` déjà présent, `database.js:286`).

---

## 8. Architecture d'implémentation recommandée

### Un endpoint serveur unique

`GET /api/verify-link?left=…&right=…` dans `server.mjs` (même style que `/api/catalog/*`) :

```
1. Base locale        → hit ? CONFIRMED(source: local)
2. TMDb configuré ?   → intersection des combined_credits (2 fiches, déjà cachées 24 h)
3. Wikidata           → wbsearchentities ×2 (cacheable) + SPARQL (QLever, secours WDQS), timeout 6 s
4. Wikipédia fr, en   → list=search + classification wikibase/catégories, timeout 6 s
5. → { verdict, films[], source, evidence[], searchLinks{} }
```

Détails qui comptent :

- **Tout côté serveur** (pas de CORS à ouvrir, User-Agent propre, clés privées), comme le client TMDb existant.
- **Caches** : LRU TTL par paire normalisée (`strictIdentityKey(left)|strictIdentityKey(right)`, ordre canonique) — réutiliser le pattern de `tmdb.js:9`. **Cache négatif court** (1 h) pour les `NOT_FOUND`, cache long (24 h+) pour les `CONFIRMED`. En-têtes HTTP `max-age` comme sur `/api/catalog/*`.
- **Persistance des confirmations** dans l'overlay local (`tmdb-overlay.local.json` ou équivalent `verify-overlay.local.json`, gitignoré) : chaque lien confirmé par les niveaux 2-3 enrichit durablement la base → le fallback s'auto-raréfie.
- Niveaux 3 et 4 peuvent être lancés **en parallèle** après échec TMDb (Promise.any sur les `CONFIRMED`) pour contenir la latence perçue ; le chrono de 30 s du jeu laisse la marge, mais viser < 3 s au P95.
- **Budget d'erreur** : tout timeout/429/5xx d'un niveau → passage au suivant, jamais d'échec bloquant ; hors ligne (PWA) l'endpoint est injoignable → le moteur garde son comportement actuel (`vote`), aucun changement de contrat.
- **Télémetrie minimale** (compteurs en mémoire exposés sur `/api/catalog/status`) : hits par niveau, latences, `NOT_FOUND` → pour décider objectivement si le niveau 4 (IMDb local) vaut son coût.
- Côté moteur : `proposeActor()` (`engine.js:137`) gagne un chemin asynchrone « vérification en cours » avant de basculer en `vote` — c'est le principal impact UX à concevoir (spinner court + verdict, ou vote pré-rempli par le verdict).

### Ordre de bataille suggéré

1. **Activer TMDb** (fournir le jeton sur l'hébergement — `roadmap.md` l.40) : c'est le plus gros gain immédiat, code déjà prêt.
2. Valider les `curl` de §3 et §4 depuis un poste avec réseau (10 min).
3. Implémenter `/api/verify-link` niveaux 2-3 + caches + overlay (le gros du travail, ~1 module serveur `src/server/verify.js` + tests `node --test` avec fetch mocké, comme `test/tmdb.test.mjs`).
4. Brancher l'UI : verdict dans l'écran de défi + bouton VAR (liens sortants + preuves internes).
5. Mesurer, puis décider du niveau 4 (IMDb local) sur données réelles.

---

## 9. Comparatif final

| Solution | Couverture | Certitude sans LLM | Clé/quota | Latence | Coût d'implémentation | Rôle |
|---|---|---|---|---|---|---|
| TMDb (déjà codé) | Très bonne, mondiale | Oui (IDs structurés) | Clé gratuite | ~200 ms | **Nul** (activer le jeton) | Niveau 1 |
| **Wikidata SPARQL (+QLever)** | Bonne (casts principaux) | **Oui (natif)** | Aucune | 0,3-2 s | Faible | **Niveau 2 — cœur du fallback** |
| **Wikipédia plein-texte fr+en** | Très bonne (sections Distribution) | Oui pour « page de film » ; cooccurrence = probable | Aucune | ~0,3 s | Faible | **Niveau 3 — filet large** |
| IMDb Datasets → SQLite | Quasi exhaustive (top-10 générique) | Oui (IDs) | Licence non-commerciale | < 1 ms | Moyen-élevé (volumétrie, cron, hébergement) | Niveau 4 optionnel |
| APIs moteurs de recherche | — | — | Fermées ou payantes (2026) | — | — | **Écarté** en programmatique |
| Liens de recherche (VAR) | Universelle | Non (humain) | Aucune | 0 | Trivial | Niveau 5, dernier recours |
| DBpedia SPARQL | Moyenne, fraîcheur en retard | Oui | Aucune | ~1 s | Faible | Non retenu (dominé par Wikidata) |
| Scraping Allociné/DDG | — | — | — | — | Fragile + juridique | **Écarté** (cf. roadmap l.41) |

## 10. Sources principales

- Wikidata : [propriété P161 (cast member)](https://www.wikidata.org/wiki/Property:P161) · [limites du Query Service](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/query_limits) (60 s/min/IP, 5 requêtes parallèles, User-Agent obligatoire) · [endpoints alternatifs](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/Alternative_endpoints) · [migration du backend WDQS vers QLever](https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_backend_update/Backend_Replacement) · [QLever (GitHub)](https://github.com/ad-freiburg/qlever)
- IMDb : [Non-Commercial Datasets](https://www.imdb.com/interfaces/) · [schéma des datasets](https://zindilis.com/posts/imdb-non-commercial-datasets-schema/) · [limitation ~10 principals par titre](https://community-imdb.sprinklr.com/imdb/topics/imdb-data-now-easily-available-to-contributors)
- Google CSE : [dépréciation / fermeture aux nouveaux clients, fin annoncée 01/2027](https://searlo.tech/google-custom-search-api-alternative) · [tarifs historiques](https://developers.google.com/custom-search/v1/overview)
- Brave : [suppression du palier gratuit début 2026](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/) · [limites 2026](https://agentdeals.dev/vendor/brave-search-api)
