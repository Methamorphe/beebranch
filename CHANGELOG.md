# Changelog

## [0.4.4] — 2026-10-28

### Vérifié

- Seconde release de contrôle, sans changement fonctionnel : confirme sur machine
  réelle l'icône de mise à jour dans l'en-tête (elle n'apparaissait pas en 0.4.3,
  qui était déjà la dernière version publiée), le redémarrage automatique après
  installation et la persistance de l'autorisation du trousseau d'une version à
  l'autre.

## [0.4.3] — 2026-10-28

### Vérifié

- Release de contrôle sans changement fonctionnel : valide sur machine réelle
  l'icône de mise à jour dans l'en-tête, le redémarrage automatique après
  installation, la persistance de l'autorisation du trousseau au-delà d'une
  mise à jour, et le retour arrière signé vers 0.4.2.

## [0.4.2] — 2026-10-28

### Ajouté

- **Mise à jour dans l'en-tête** : une icône de téléchargement apparaît dans la
  barre supérieure dès qu'une version est publiée (point d'accent, libellé
  accessible). Le clic ouvre Réglages → Mises à jour. Vérification silencieuse
  au démarrage, au retour de focus et toutes les six heures.
- **Redémarrage automatique après installation** : l'application se relance
  seule sur la nouvelle version ; le bouton affiche « Redémarrage… » pendant la
  bascule. Idem pour le rollback.

### Modifié

- **Signature macOS** : bundle signé avec l'identité Apple Distribution de
  l'équipe, donc stable d'un build à l'autre. Les autorisations du trousseau
  sont mémorisées : plus de demande du mot de passe du trousseau à chaque
  lancement. Le paquet reste non notarié.

## [0.4.1] — 2026-10-28

### Modifié

- **Références du graphe** : une branche locale et son miroir distant posés sur
  le même commit (`main`, `origin/main`) comptent pour une seule référence —
  plus de `+1` ni de menu au survol, le nom et le type restant dans l'infobulle.
  Badge et menu distinguent local, distant et tag par une icône (fourche, nuage,
  étiquette). Une branche en avance ou en retard reste affichée aux deux commits
  concernés, chacun avec son badge.

## [Unreleased] — barre d’actions, branches dans le graphe, détail de commit

### Modifié

- **Historique / saisie du commit** : canvas maintenu dans le viewport par
  positionnement sticky, sans translation différée après défilement. Évite
  les images transitoires décalées lors des repeints du panneau de commit.
  Régression contrôlée avant le prochain redessin et pendant la saisie.

- **Réglages / Profils** : profils enregistrés présentés séparément, identité
  et préférences regroupées dans un formulaire à deux colonnes, contrôles
  alignés et actions en pied de formulaire. Édition avec accès direct au
  formulaire, annulation et conservation des champs en cas d’échec. Captures
  après défilement et vérifications création/édition à trois largeurs.

- **Navigation et écrans secondaires** : Historique placé en premier dans la
  navigation et la palette. En-têtes contextualisés, panneaux, formulaires,
  sélections et onglets harmonisés avec l’Historique. Libellés persistants pour
  Stash, Synchronisation, Outils et création de workspace ; actions de stash
  en français, états vides guidés et adaptation aux fenêtres étroites.
- **Vérification UI** : captures des 17 écrans secondaires à 1440, 1024 et
  390 px, contrôle du débordement horizontal et de la navigation active.

- **Barre d’actions du dépôt** : 46 px, actions icône + libellé sur une seule
  ligne, sélecteurs dépôt/branche compacts. Les libellés passent en icônes sous
  1060 px ; aucune barre de défilement horizontale à 960 px.
- **Connexion GitLab** : la page empile la connexion et les projets (deux
  colonnes) puis les merge requests sur toute la largeur. Les cartes ne sont
  plus écrasées à 34 px et le formulaire de création de MR respire.
- **Détail de commit** : en-tête sha / références / sujet / métadonnées, corps
  du message sans répétition du sujet, fichiers avec badge de statut, dossier
  tronqué avant le nom, additions/suppressions alignées et total du commit.
- **Glisser-déposer de branches** : déposer une référence sur une autre
  branche locale ouvre un menu (avancer en fast-forward quand c’est possible,
  fusionner, rebaser, comparer). Un aperçu (commits en avance/retard,
  fast-forward, extraction de branche, worktree modifié) précède toute
  mutation ; Échap ou un dépôt hors cible annule. Halo sur la cible et
  étiquette de glissement pendant l’opération.
- **Comparaison / code** : en-tête du commit (sha, sujet, auteur, date), barre
  de fichier (statut, chemin, +/−, nombre de hunks), liste de fichiers qui ne
  déborde plus, coloration syntaxique (Dart inclus), numéros ancien et nouveau
  en mode unifié, colonnes « Ancien / Nouveau » séparées en côte à côte, mots
  modifiés surlignés, en-têtes de hunk collants, défilement horizontal au lieu
  d’une ellipse, libellés de mode en français et pied de page épuré.

### Supprimé

- **Vue « Branches »** : retirée de la navigation, du raccourci et de la
  palette. La création se fait dans l’arbre (bouton `+` de la colonne
  Branches / tags, menu contextuel d’un commit, ⌘B) et les actions de branche
  (checkout, renommer, supprimer local/distant, fusionner dans la courante,
  comparer à HEAD) sont dans le menu contextuel d’une référence.

### Corrigé

- **Endpoint de mise à jour** : l'URL du manifeste signé est désormais une
  source unique (`BEEBRANCH_UPDATE_ENDPOINT`, injectée par la CI) utilisée par
  l'affichage, la vérification, le téléchargement et le rollback ; auparavant
  seul l'affichage suivait la variable et la requête partait de
  `tauri.conf.json`. Un endpoint non HTTPS hors loopback est refusé
  (`update.invalid_endpoint`). Les manifestes sont hébergés sur GitHub Releases.
- **Fetch sans clignotement** : un rafraîchissement du dépôt garde la page de
  commits et l’inspecteur à l’écran pendant le rechargement
  (stale-while-revalidate) au lieu de vider le graphe et d’afficher
  « Chargement du commit… ». Le changement de dépôt, de filtre ou de branche
  vide toujours l’ancienne page.
- Les lignes de contexte d’un diff unifié affichent de nouveau leur contenu
  (elles étaient vides) et portent leurs deux numéros de ligne.
- Plus de barres de défilement fugitives au clic sur un onglet : le retour
  d’appui n’utilise plus `transform`, le focus est un anneau `box-shadow` et
  les bandeaux ne défilent que sur un axe.

## [0.4.0] — 2026-10-27

### Ajouté — P3

- **Undo / redo explicite** : matrice Git complète (commit, amend, checkout,
  branches, tags, remotes, stash create, worktrees, merge/rebase/cherry-pick/
  revert terminés ou en cours via abort typé, reset soft/mixed). Empreintes
  HEAD/index/status/refs/fichiers affectés, préconditions, aucune sauvegarde
  applicative, redo borné, journal SQLite des étapes, panneau de récupération
  avec commande et SHA, restauration interrompue non retentée au démarrage.
  Les actions irréversibles (discard, reset --hard, stash drop/apply/pop,
  fetch, push, submodule update) ne sont jamais proposées.
- **Drag & drop** : branche sur branche (merge/rebase) avec aperçu (commits,
  fast-forward, worktree, extraction concurrente), confirmation obligatoire,
  annulation sans mutation, conflits visibles ; réordonnancement des commits du
  plan de rebase par glisser-déposer.
- **Design system** : tokens espacement/typage/profondeur/mouvement, densité
  compacte ou confortable, thèmes clair/sombre/système, primitive de dialogue
  et de bouton, animations courtes désactivées par `prefers-reduced-motion`.
- **Gros dépôts** : `git log` consommé en flux par le graphe, curseur
  `index:sha` ; les pages profondes ne parcourent plus le préfixe.
  `linear-1m` PERF-03 : 38,6 s → 18 ms pour 10 pages (mesure locale).
- **Workspaces** : groupes locaux bornés à 20 dépôts, fetch/pull multi-dépôts
  (4 travailleurs), résultat par dépôt, échec isolé, sessions fermées après
  l'action, confirmation explicite du pull.
- **Accessibilité** : lien d'évitement, focus visible, piège/restauration du
  focus dans tous les dialogues, rôles et libellés, annonces d'erreurs,
  contrastes vérifiés (texte ≥ 7:1, muted ≥ 4,5:1, lanes ≥ 3:1) dans les deux
  thèmes, audit automatisé des vues principales.
- **Distribution** : packaging Windows/macOS/Linux, signature/notarisation
  macOS, signature Windows, artefacts de mise à jour signés, manifeste
  `latest.json`, rollback signé via `rollback.json`, notes de version, audit
  anti-télémétrie. Une signature absente ou invalide est refusée.

### Vérifié

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace`.
- `npm run build`, `npm run lint`, `npm run ui:smoke` : 113 contrôles UX dont
  undo, drag & drop, aperçu sans mutation, workspaces, densité, contrastes,
  audit a11y, mises à jour signées.
- `node scripts/audit-no-telemetry.mjs` : aucune référence télémétrie.
- Bench PERF-03 avant/après sur `linear-100k` et `linear-1m`.

### Limites connues

- Le rollback et l'installation sur machine propre sont exercés par la
  matrice CI de release ; l'environnement de développement ne peut pas signer
  ni installer un bundle de production.
- Le flux de log garde un processus `git log` par session active ; il est
  annulé à la fermeture de session.

# Changelog

## [0.3.0] — 2026-10-27

### Ajouté — P2

- **Rebase interactif** : plan généré par l’application (pick/reword/squash/
  fixup/edit/drop), réordonnancement, messages personnalisés via
  `GIT_SEQUENCE_EDITOR` + `commit --amend -F`, conflits visibles, continue/
  skip/abort, validation stricte du plan contre `rev-list upstream..HEAD`.
- **Conflits 3 panneaux** : base/ours/theirs + résultat éditable, acceptation
  d’une version, combinaison, édition brute, détection des marqueurs, refus
  explicite des binaires et fichiers > 8 Mio, écriture atomique préservant
  CRLF/LF, marquage résolu dans l’index.
- **Cherry-pick / revert** : sélection ordonnée, plage, conflits, continue/
  skip/abort, refus d’opération concurrente ou worktree sale.
- **Worktrees** : liste avec statut par worktree, création, ouverture dans un
  onglet, lock/unlock, prune, suppression confirmée (saisie du chemin si sale).
- **Historique de fichier et blame** : suivi des renommages, plafonds
  (500 commits / 2 000 lignes), navigation vers le commit.
- **Recherche approfondie** : message, auteur, SHA, chemin, contenu borné et
  annulable (`git grep` 20 s), filtres date/auteur/chemin, scope affiché.
- **Command palette et raccourcis** : recherche floue, actions indisponibles
  expliquées, raccourcis configurables sans doublon silencieux, aide.
- **GitLab avancé** : discussions inline ancrées sur `diff_refs` (création,
  réponse, résolution), approbations avec feature detection, merge par SHA
  (405/406/409 expliqués), jobs et logs bornés.
- **Submodules** : statuts, add, init/update récursif borné, sync, pointeur
  explicite.
- **Tags et remotes** : tags annotés (message/tagger), suppression et push
  explicites, gestion des remotes, refus des URL à mot de passe, prune.
- **Profils** : identité Git, préférences, instance GitLab par profil, tokens
  isolés dans le trousseau, application de l’identité au dépôt.
- **Patches** : création depuis worktree/index/commit/plage, provenance
  visible, application vérifiée sans altération en cas de conflit, binaires
  refusés, export explicite.
- **Secrets** : les builds de développement stockent le token GitLab dans un
  fichier 0600 (`secrets-dev.json`) au lieu du keychain macOS, dont l’ACL est
  invalidée à chaque recompilation non signée (« Toujours autoriser » redemandé
  à chaque lancement). Une migration one-shot copie le token existant puis ne
  relit plus le keychain. Les builds release conservent le keychain.
- **Clonage** : écran d’accueil sans argumentaire, choix d’un dépôt local ou
  clone d’un projet GitLab accessible à l’utilisateur (recherche, URL SSH/HTTPS
  remplie automatiquement), branche/profondeur/sous-modules optionnels,
  destination absolue validée, aucun écrasement de dossier existant.
  HTTPS utilise le token GitLab via un helper `GIT_ASKPASS` temporaire (0600),
  jamais dans l’URL/l’argv ; les erreurs SSH (known_hosts, publickey) et HTTPS
  sont expliquées séparément.
- **Design** : refonte complète du shell et des écrans d’après la maquette de
  référence (palette, densité, panneaux, palette de commandes, thèmes).
  **Typographie Geist / Geist Mono embarquée**, base 13 px, contraste des
  textes secondaires porté à ≥ 7:1 dans les deux thèmes (vérifié par le smoke).

### Vérifié

- `cargo test --workspace` : 313 tests verts (dont 18 scénarios P2 Git et
  10 contrats GitLab avancés).
- `npm run build`, `npm run lint`, `npm run ui:smoke` : graphe, diff, staging,
  navigation P1 et 9 écrans P2 (conflits, rebase, worktrees, tags, remotes,
  submodules, patches, blame, profils) avec résolution de conflit exercée,
  police Geist chargée et contraste latéral ≥ 7:1 en sombre/clair.

### Limites connues

- Le drag & drop du rebase reste en P3 ; le réordonnancement se fait par
  flèches.
- Le merge 3-way d’un patch peut encore échouer après `--check` sur une dérive
  extrême ; l’erreur est explicite et le patch n’est pas rejoué.
- P2-T01 à T14 sont couverts côté comportement et tests ; le dogfooding humain
  reste à planifier.

## [0.2.0] — 2026-10-27

### Ajouté — P1

- **Index** : staging/unstaging par fichier, hunk et ligne via un patch engine
  (`git diff` → patch réduit → `git apply --check` → `git apply`), fingerprints
  SHA-256, discard irréversible confirmé, `.gitignore` explicite. CRLF, absence
  de newline final, mode exécutable, Unicode et renommages couverts.
- **Commit** : message sur stdin, amend avec ou sans conservation du message,
  hooks Git exécutés et sortie affichée, identité préflight, signature déléguée
  à Git (`commit.gpgsign`, `user.signingkey`, `gpg.format`), aucun `--no-verify`.
- **Branches** : création, checkout, renommage, suppression locale/distante,
  upstream, comparaison ahead/behind, préflight mergée/courante/worktree.
- **Synchronisation** : fetch/pull/push streamés, profondeur de pull
  (`pull.rebase`), `--force-with-lease` explicite avec SHA attendu, annulation,
  revalidation du remote après push annulé, erreurs auth/SSH/non-fast-forward.
- **Historique** : merge/rebase, conflits, `continue`/`skip`/`abort`, marquage
  résolu, reprise après redémarrage, refus d'une seconde opération.
- **Stash** : création (untracked explicite), liste, apply/pop, pop conflictuel
  laissant le stash intact, drop confirmé avec SHA récupérable.
- **Multi-dépôts** : onglets, sessions isolées, fermeture avec confirmation si
  opération/conflit, restauration des onglets et de l'onglet actif.
- **Recherche** : message/auteur/SHA, profondeur explicite, pagination,
  annulation, aucune lecture complète implicite.
- **Graphe** : filtres branche/toutes refs (stash), menu contextuel
  checkout/branche/comparaison/copie SHA/MR, badges MR/CI, rafraîchissement.
- **GitLab** : liste des MR (scopes), détail, création avec vérification de la
  branche poussée, ouverture navigateur, pipelines et badge CI, polling 30 s
  actif uniquement fenêtre visible, association dépôt ↔ projet.
- **Sécurité destructive** : politique centralisée (`Confirmation`, saisie du
  nom), journal SQLite des actions, aucune sauvegarde applicative.
- **Outils externes** : détection éditeur/terminal/diff/merge, configuration
  argv sans shell, ouverture au bon worktree, diff/merge avec placeholders.
- **Benchmarks** : PERF-07 (staging partiel) et PERF-10 (fetch + refresh)
  mesurables et intégrés au set réduit.

### Vérifié

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace` (tests P1 dédiés inclus).
- `npm run lint`, `npm run build`, `npm run ui:smoke` (graphe, diff, staging de
  ligne, navigation P1).
- Scénarios PERF-07 et PERF-10 mesurés (`target/bench-perf07.json`,
  `target/bench-perf10.json`).
- Workflow complet automatisé : branche → staging partiel → commit → stash →
  push → merge conflictuel → résolution → continue → fetch.

### Limites connues

- P1-T14 (dogfooding par trois développeurs) n'est pas exécuté dans cet
  environnement : le rapport et le protocole sont dans
  `docs/reviews/p1-dogfooding.md`.
- La baseline `--all-reduced --assert` conserve PERF-05/06 mesurés sur une
  machine plus calme ; les nouveaux scénarios P1 sont conforme à leurs budgets
  absolus.


## [0.1.0] — 2026-10-27

### Ajouté — P0

- Workspace Rust (`core`, `git`, `gitlab`, `store`, `app`, `bench`) et shell
  Tauri 2 / React 19.3 avec CSP restrictive.
- Moteur Git CLI unique : allowlist argv, environnement contrôlé, capture
  bornée, streaming, annulation, timeouts, redaction centralisée, détection de
  capacité (Git ≥ 2.34).
- Sessions worktree-aware : découverte (worktree, common dir, bare, submodule),
  état intermédiaire (merge, rebase, cherry-pick, revert, séquence, bisect,
  conflits, verrous), watcher avec debounce et invalidation ciblée, file de
  mutations sérialisée, générations.
- Modèle de lecture : refs, status `--porcelain=v2 -z`, log paginé, détail de
  commit, diff unifié avec plafonds, fichiers binaires, CRLF, Unicode, absence
  de newline final.
- Prototypes frontend : graphe canvas virtualisé avec lanes Rust et frame
  timing, diff hunk/inline/split avec fenêtrage et coloration limitée.
- GitLab self-hosted REST v4 : normalisation d'URL, PAT dans le keychain
  (features natives `apple-native`/`windows-native`/`sync-secret-service`),
  validation `GET /user`, CA interne, projets paginés, cache ETag, mapping
  d'erreurs 401/403/404/409/422/429/5xx. Validé en live sur GitLab 19.2.9.
- Erreurs et reprise : taxonomie `AppError`, mapping des erreurs Git connues,
  journal SQLite, détection des opérations interrompues, panneau de reprise,
  export de diagnostics redacté.
- Harnais de benchmark : corpus déterministe (10k→1M commits, branches, merges,
  fichiers, diff, CRLF, worktrees), scénarios PERF-01..12 (07 et 10 déclarés
  P1), rapports JSON versionnés, baseline et seuils CI, job nightly.

### Vérifié

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace`, `npm run lint`, `npm run build`.
- Set de benchmarks réduit sous les seuils de la baseline versionnée.
## [0.3.0] — 2026-10-27

### Ajouté — P2

- **Rebase interactif** : plan généré par l’application (pick/reword/squash/
  fixup/edit/drop), réordonnancement, messages personnalisés via
  `GIT_SEQUENCE_EDITOR` + `commit --amend -F`, conflits visibles, continue/
  skip/abort, validation stricte du plan contre `rev-list upstream..HEAD`.
- **Conflits 3 panneaux** : base/ours/theirs + résultat éditable, acceptation
  d’une version, combinaison, édition brute, détection des marqueurs, refus
  explicite des binaires et fichiers > 8 Mio, écriture atomique préservant
  CRLF/LF, marquage résolu dans l’index.
- **Cherry-pick / revert** : sélection ordonnée, plage, conflits, continue/
  skip/abort, refus d’opération concurrente ou worktree sale.
- **Worktrees** : liste avec statut par worktree, création, ouverture dans un
  onglet, lock/unlock, prune, suppression confirmée (saisie du chemin si sale).
- **Historique de fichier et blame** : suivi des renommages, plafonds
  (500 commits / 2 000 lignes), navigation vers le commit.
- **Recherche approfondie** : message, auteur, SHA, chemin, contenu borné et
  annulable (`git grep` 20 s), filtres date/auteur/chemin, scope affiché.
- **Command palette et raccourcis** : recherche floue, actions indisponibles
  expliquées, raccourcis configurables sans doublon silencieux, aide.
- **GitLab avancé** : discussions inline ancrées sur `diff_refs` (création,
  réponse, résolution), approbations avec feature detection, merge par SHA
  (405/406/409 expliqués), jobs et logs bornés.
- **Submodules** : statuts, add, init/update récursif borné, sync, pointeur
  explicite.
- **Tags et remotes** : tags annotés (message/tagger), suppression et push
  explicites, gestion des remotes, refus des URL à mot de passe, prune.
- **Profils** : identité Git, préférences, instance GitLab par profil, tokens
  isolés dans le trousseau, application de l’identité au dépôt.
- **Patches** : création depuis worktree/index/commit/plage, provenance
  visible, application vérifiée sans altération en cas de conflit, binaires
  refusés, export explicite.
- **Secrets** : les builds de développement stockent le token GitLab dans un
  fichier 0600 (`secrets-dev.json`) au lieu du keychain macOS, dont l’ACL est
  invalidée à chaque recompilation non signée (« Toujours autoriser » redemandé
  à chaque lancement). Une migration one-shot copie le token existant puis ne
  relit plus le keychain. Les builds release conservent le keychain.
- **Clonage** : écran d’accueil sans argumentaire, choix d’un dépôt local ou
  clone d’un projet GitLab accessible à l’utilisateur (recherche, URL SSH/HTTPS
  remplie automatiquement), branche/profondeur/sous-modules optionnels,
  destination absolue validée, aucun écrasement de dossier existant.
  HTTPS utilise le token GitLab via un helper `GIT_ASKPASS` temporaire (0600),
  jamais dans l’URL/l’argv ; les erreurs SSH (known_hosts, publickey) et HTTPS
  sont expliquées séparément.
- **Design** : refonte complète du shell et des écrans d’après la maquette de
  référence (palette, densité, panneaux, palette de commandes, thèmes).
  **Typographie Geist / Geist Mono embarquée**, base 13 px, contraste des
  textes secondaires porté à ≥ 7:1 dans les deux thèmes (vérifié par le smoke).

### Vérifié

- `cargo test --workspace` : 313 tests verts (dont 18 scénarios P2 Git et
  10 contrats GitLab avancés).
- `npm run build`, `npm run lint`, `npm run ui:smoke` : graphe, diff, staging,
  navigation P1 et 9 écrans P2 (conflits, rebase, worktrees, tags, remotes,
  submodules, patches, blame, profils) avec résolution de conflit exercée,
  police Geist chargée et contraste latéral ≥ 7:1 en sombre/clair.

### Limites connues

- Le drag & drop du rebase reste en P3 ; le réordonnancement se fait par
  flèches.
- Le merge 3-way d’un patch peut encore échouer après `--check` sur une dérive
  extrême ; l’erreur est explicite et le patch n’est pas rejoué.
- P2-T01 à T14 sont couverts côté comportement et tests ; le dogfooding humain
  reste à planifier.

## [0.2.0] — 2026-10-27

### Ajouté — P1

- **Index** : staging/unstaging par fichier, hunk et ligne via un patch engine
  (`git diff` → patch réduit → `git apply --check` → `git apply`), fingerprints
  SHA-256, discard irréversible confirmé, `.gitignore` explicite. CRLF, absence
  de newline final, mode exécutable, Unicode et renommages couverts.
- **Commit** : message sur stdin, amend avec ou sans conservation du message,
  hooks Git exécutés et sortie affichée, identité préflight, signature déléguée
  à Git (`commit.gpgsign`, `user.signingkey`, `gpg.format`), aucun `--no-verify`.
- **Branches** : création, checkout, renommage, suppression locale/distante,
  upstream, comparaison ahead/behind, préflight mergée/courante/worktree.
- **Synchronisation** : fetch/pull/push streamés, profondeur de pull
  (`pull.rebase`), `--force-with-lease` explicite avec SHA attendu, annulation,
  revalidation du remote après push annulé, erreurs auth/SSH/non-fast-forward.
- **Historique** : merge/rebase, conflits, `continue`/`skip`/`abort`, marquage
  résolu, reprise après redémarrage, refus d'une seconde opération.
- **Stash** : création (untracked explicite), liste, apply/pop, pop conflictuel
  laissant le stash intact, drop confirmé avec SHA récupérable.
- **Multi-dépôts** : onglets, sessions isolées, fermeture avec confirmation si
  opération/conflit, restauration des onglets et de l'onglet actif.
- **Recherche** : message/auteur/SHA, profondeur explicite, pagination,
  annulation, aucune lecture complète implicite.
- **Graphe** : filtres branche/toutes refs (stash), menu contextuel
  checkout/branche/comparaison/copie SHA/MR, badges MR/CI, rafraîchissement.
- **GitLab** : liste des MR (scopes), détail, création avec vérification de la
  branche poussée, ouverture navigateur, pipelines et badge CI, polling 30 s
  actif uniquement fenêtre visible, association dépôt ↔ projet.
- **Sécurité destructive** : politique centralisée (`Confirmation`, saisie du
  nom), journal SQLite des actions, aucune sauvegarde applicative.
- **Outils externes** : détection éditeur/terminal/diff/merge, configuration
  argv sans shell, ouverture au bon worktree, diff/merge avec placeholders.
- **Benchmarks** : PERF-07 (staging partiel) et PERF-10 (fetch + refresh)
  mesurables et intégrés au set réduit.

### Vérifié

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace` (tests P1 dédiés inclus).
- `npm run lint`, `npm run build`, `npm run ui:smoke` (graphe, diff, staging de
  ligne, navigation P1).
- Scénarios PERF-07 et PERF-10 mesurés (`target/bench-perf07.json`,
  `target/bench-perf10.json`).
- Workflow complet automatisé : branche → staging partiel → commit → stash →
  push → merge conflictuel → résolution → continue → fetch.

### Limites connues

- P1-T14 (dogfooding par trois développeurs) n'est pas exécuté dans cet
  environnement : le rapport et le protocole sont dans
  `docs/reviews/p1-dogfooding.md`.
- La baseline `--all-reduced --assert` conserve PERF-05/06 mesurés sur une
  machine plus calme ; les nouveaux scénarios P1 sont conforme à leurs budgets
  absolus.


## [0.1.0] — 2026-10-27

### Ajouté — P0

- Workspace Rust (`core`, `git`, `gitlab`, `store`, `app`, `bench`) et shell
  Tauri 2 / React 19.3 avec CSP restrictive.
- Moteur Git CLI unique : allowlist argv, environnement contrôlé, capture
  bornée, streaming, annulation, timeouts, redaction centralisée, détection de
  capacité (Git ≥ 2.34).
- Sessions worktree-aware : découverte (worktree, common dir, bare, submodule),
  état intermédiaire (merge, rebase, cherry-pick, revert, séquence, bisect,
  conflits, verrous), watcher avec debounce et invalidation ciblée, file de
  mutations sérialisée, générations.
- Modèle de lecture : refs, status `--porcelain=v2 -z`, log paginé, détail de
  commit, diff unifié avec plafonds, fichiers binaires, CRLF, Unicode, absence
  de newline final.
- Prototypes frontend : graphe canvas virtualisé avec lanes Rust et frame
  timing, diff hunk/inline/split avec fenêtrage et coloration limitée.
- GitLab self-hosted REST v4 : normalisation d'URL, PAT dans le keychain
  (features natives `apple-native`/`windows-native`/`sync-secret-service`),
  validation `GET /user`, CA interne, projets paginés, cache ETag, mapping
  d'erreurs 401/403/404/409/422/429/5xx. Validé en live sur GitLab 19.2.9.
- Erreurs et reprise : taxonomie `AppError`, mapping des erreurs Git connues,
  journal SQLite, détection des opérations interrompues, panneau de reprise,
  export de diagnostics redacté.
- Harnais de benchmark : corpus déterministe (10k→1M commits, branches, merges,
  fichiers, diff, CRLF, worktrees), scénarios PERF-01..12 (07 et 10 déclarés
  P1), rapports JSON versionnés, baseline et seuils CI, job nightly.

### Vérifié

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -D
  warnings`, `cargo test --workspace`, `npm run lint`, `npm run build`.
- Set de benchmarks réduit sous les seuils de la baseline versionnée.
