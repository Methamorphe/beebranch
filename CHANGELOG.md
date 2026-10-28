# Changelog

## [0.6.3] — 2026-10-28

### Ajouté

- **Amendement depuis le graphe ou le diff** : le menu contextuel d’un commit
  HEAD et son nom dans le diff proposent « Amender ce commit… ». La boîte de
  dialogue reprend le message (éditable), inclut les fichiers préparés, signale
  la réécriture d’historique et passe par le flux amend existant (hooks,
  signature, undo). L’action n’apparaît que pour HEAD et hors opération Git.
- **Fichiers Markdown rendus** : dans le diff d’un fichier `.md`, le bouton
  « Rendu » affiche le document mis en forme (titres, listes, tableaux, code)
  au lieu du patch. Le contenu est lu à la révision du diff — copie de travail,
  index, commit ou extrémité d’une comparaison — et le retour à « Diff » est
  immédiat. Le HTML brut est ignoré, les images restent bloquées et seuls les
  liens `https` s’ouvrent dans le navigateur système.

### Modifié

- **Comparaison A→B : le pied du graphe s’efface** : pendant une comparaison,
  la ligne de statut sous les commits disparaît pour laisser toute la hauteur
  utile à l’inspecteur et au patch, puis revient à la fermeture de la
  comparaison.

### Corrigé

- **Notes de version rendues en Markdown** : le manifeste signé transporte les
  notes de `docs/releases/*.md`, mais les réglages les affichaient telles
  quelles. Elles sont désormais rendues : titres, listes, gras et code, sans
  jamais injecter de HTML brut.
- **Double-clic sur une branche distante d’un commit partagé** : le double-clic
  dans le graphe activait la première référence décorant la ligne au lieu du
  badge visé, donc parfois une autre branche locale à son commit courant. Le
  badge sous le curseur est désormais résolu ; une branche locale de suivi en
  retard reste replacée sur le commit distant avant la checkout.
- **Un fichier cliqué dans un commit ouvre son propre diff** : le chemin était
  bien transmis par le détail du commit, mais la commande de diff l’ignorait
  pour la cible `commit` et renvoyait le patch entier du commit, dont la vue
  affichait toujours le premier fichier. Le chemin filtre désormais la sortie,
  commit racine sans parent compris.

## [0.6.2] — 2026-10-28

### Ajouté

- **Comparaison de deux commits seulement (⌘/Ctrl+clic)** : après un clic sur
  un commit, ⌘+clic (Ctrl+clic sous Windows/Linux) sur un autre ouvre le diff
  A → B entre ces deux arbres, même si des commits se trouvent entre eux. La
  comparaison ne liste que les deux extrémités et la sélection ne contient
  qu'elles, ce qui vaut aussi pour Cherry-pick et Revert ; Maj+clic conserve la
  sélection de plage.

### Modifié

- **Liste des branches au survol compacte** : l’en-tête (SHA) et le pied de
  page disparaissent, le libellé de type quitte chaque ligne et seuls l’icône
  et le nom restent, sur des rangées de 24 px et une largeur ajustée au nom le
  plus long (260 px au maximum). Le type et le double-clic restent disponibles
  dans l’infobulle et le libellé accessible de chaque ligne.

### Corrigé

- **Diff d'une comparaison A→B enfin lisible** : le patch n'est plus rendu sous
  la liste des fichiers, dans l'inspecteur étroit où l'en-tête, les commits et
  la liste ne lui laissaient que quelques pixels. La liste occupe désormais
  toute la hauteur de l'inspecteur et défile.
- **Un clic sur un fichier comparé ouvre son diff dans la région centrale**,
  à la place du graphe, avec le chemin du fichier et sa fermeture ; un second
  clic sur la même ligne, le bouton × ou un clic sur un commit ramène le graphe.
  La comparaison et sa liste restent affichées à droite.
- **`origin/HEAD` ne décore plus les commits** : cette référence symbolique
  désigne la branche par défaut du remote, déjà affichée sur le même commit ;
  Git l’inclut pourtant dans ses décorations. Les badges et la liste au survol
  la masquent désormais, ce qui retire une ligne « distante » trompeuse.

## [0.6.1] — 2026-10-28

### Ajouté

- **Sélection d'une plage de commits** : après un clic, Maj+clic sur un autre
  commit sélectionne tous les commits entre les deux, de l'ancre vers le clic ;
  Maj+↑/↓ étend la plage au clavier. La sélection est ordonnée du plus ancien au
  plus récent, ce qui est l'ordre d'application de Cherry-pick et Revert, et le
  diff A→B s'ouvre sur la plage.

### Modifié

- **Panneau de comparaison lisible comme chez GitKraken** : l'en-tête annonce le
  nombre de commits sélectionnés et « Diff de N commits », puis liste chaque
  commit comparé (sujet, date, auteur, SHA) du plus récent au plus ancien. Les
  fichiers passent d'une liste à plat à une arborescence repliable, dossiers à
  enfant unique compactés (`src/app/components`), avec bascule
  Chemin / Arborescence ; le fichier ouvert garde son chemin et ses statistiques
  au-dessus du diff. En mode Unifié, les mots modifiés sont désormais soulignés
  comme en Côte à côte.
- **« Comparer » sur toute la sélection** : au-delà de deux commits cochés, le
  bouton compare la sélection du plus ancien au plus récent au lieu d'exiger
  exactement deux commits ; la liste d'ordre se compacte en `N commits · sha…sha`
  pour ne plus afficher une puce par commit.

## [0.6.0] — 2026-10-28

### Ajouté

- **Mise à jour installée depuis l'en-tête** : une notification propose la
  version signée dès sa publication, avec la progression réelle du
  téléchargement et un report possible ; l'icône de mise à jour de la barre
  supérieure lance directement le paquet signé puis le redémarrage. La page
  Profils conserve son flux explicite avec confirmation.
- **Comparaison A→B dans l'historique** : Maj+clic sur un second commit (ou
  « Comparer A→B » en sélection multiple) ouvre le diff dans l'inspecteur, à
  droite du graphe, sans quitter la vue Historique. L'inversion A↔B et
  l'ouverture en plein écran restent disponibles.
- **Date et heure dans l'historique** : la colonne Date affiche l'heure locale
  du commit en plus du jour (`28 oct. 2026 14:32`). Largeur par défaut portée à
  128 px et plancher à 112 px pour que l'horodatage tienne sur une ligne ;
  toujours redimensionnable et réinitialisable.

### Modifié

- **Graphe au niveau de GitKraken** : pas constant de 22 px et colonne élargie
  avec l'historique (jusqu'à 420 px) au lieu d'écraser dix-huit voies dans
  150 px. Les arêtes de parenté quittent la pastille à l'horizontale et
  rejoignent leur voie par une équerre arrondie de 7 px, au lieu d'une courbe
  en S traversant toute la ligne. Chaque voie porte ses extrémités (`rails`) :
  elle s'ouvre sur le commit qui la crée et s'arrête sur celui qu'elle atteint.
  Pastilles de commit à 11 px, palette de huit voies saturée (contraste ≥ 4,9:1
  sur le fond sombre comme sur le clair) et tracé borné à la colonne du graphe.
- **Infobulle de commit** : le survol n'ouvre plus de popup quand le sujet tient
  dans la colonne ; il ne s'affiche que si le sujet est tronqué au rendu, après
  chaque redimensionnement.

### Corrigé

- **Fusion réduite à un fast-forward** : « Fusionner » avançait la cible sans
  créer de commit de fusion dès qu'un fast-forward était possible, si bien que
  le graphe ne montrait pas que la branche avait rejoint l'autre. « Fusionner »
  passe désormais `--no-ff` et produit un vrai commit de fusion ; l'entrée
  « Avancer » reste disponible pour un fast-forward explicite. L'aperçu de
  confirmation annonce lequel des deux aura lieu.
- **Double-clic sur une branche distante désynchronisée** : si une branche
  locale suit déjà cette référence, son sommet est replacé sur le commit
  distant avant la checkout, puis la branche est activée — y compris lorsqu'elle
  est déjà la branche courante. L'opération reste annulable (sommet précédent et
  branche active restaurés). Un checkout qui écraserait des modifications
  locales est refusé par Git.
- **Progression de mise à jour** : le plugin rapporte la taille de chaque
  fragment reçu, pas le total ; les fragments sont désormais cumulés pour
  afficher un pourcentage exact.

## [0.5.1] — 2026-10-28

### Ajouté

- **Comparer deux commits par Maj+clic** : après avoir sélectionné un commit,
  Maj+clic sur un second ouvre directement le diff A → B dans la vue
  Comparaison, sans passer par « Sélection multiple ». Le premier commit
  sélectionné (ou le dernier coché) sert de base ; le couple reste sélectionné
  dans le graphe.

### Modifié

- **Graphe de l’historique redessiné** : les couleurs de branche restent
  confinées à la colonne du graphe. Les bandes teintées qui coloraient la ligne
  entière disparaissent ; la sélection se marque par un léger relief de surface
  et le repère accent à gauche de la ligne. Les voies sont tracées d’un seul
  trait continu, sans transparence superposée : les fourches ne forment plus de
  taches plus sombres là où une courbe recouvrait une voie. Les courbes de
  parenté sont lissées, les pastilles de commit sont dessinées après toutes les
  arêtes (aucune voie ne les recouvre plus) et le halo gris clair qui entourait
  chaque pastille est remplacé par un anneau à la couleur du fond, qui
  interrompt proprement la voie.

### Corrigé

- **Étiquette de branche courante (HEAD) illisible dans le graphe** : le texte
  et l’icône étaient peints dans le jaune d’accent sur un fond jaune d’accent
  (contraste ≈ 1,2:1). Ils utilisent désormais `--accent-contrast`, comme tous
  les contrôles remplis d’accent de l’application (contraste ≈ 10:1).

### Distribution

- **Build macOS signé et notarié** : signature `Developer ID Application:
  beecoming (JFSQ98955P)` avec hardened runtime, notarisation Apple et
  agrafage de l'app et du DMG. Gatekeeper n'exige plus de contournement au
  premier lancement.
- La notarisation CI utilise une clé API App Store Connect
  (`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_P8`) au lieu d'un mot
  de passe d'application.
- L'identité de signature change par rapport aux versions précédentes : macOS
  peut redemander l'accès au trousseau et aux dossiers choisis au premier
  lancement.

### Interne

- La preuve visuelle headless (`scripts/ui-smoke.mjs`) rend un historique à deux
  voies avec un merge toutes les six lignes : les fourches, les courbes et les
  pastilles sont couvertes par les captures, et non plus une seule ligne droite.

## [0.5.0] — 2026-10-28

### Ajouté

- **Interface redimensionnable** : glisser les séparateurs pour ajuster la
  navigation (180–420 px), la colonne Références, la largeur du graphe, les
  colonnes Auteur et Date, ainsi que le panneau de détail ou de préparation du
  commit (300–760 px). Les colonnes se réinitialisent par double-clic sur un
  séparateur ou via « Réinitialiser les colonnes » ; toutes les largeurs sont
  mémorisées et re-clampées à la taille de la fenêtre. Flèches ←/→ au clavier
  sur un séparateur.
- **Comparaison entre deux commits dans l’historique** : sélectionnez un
  commit puis Maj+clic sur un second : le diff s’ouvre immédiatement dans la
  vue Comparaison. Avec « Sélection multiple » activée, cochez deux commits
  puis cliquez « Comparer A → B ». Le sens du diff suit l’ordre de sélection
  (premier commit → second commit), sans mutation du dépôt.
- **Colonne Date dans l’historique** : la date du commit (committer, et non
  l’auteur) est toujours affichée à droite de l’auteur. L’ancienne option
  d’affichage « Date » disparaît.
- **Connexion GitLab héritée de Git** : au démarrage, les identifiants HTTPS
  déjà configurés pour Git sont détectés en lecture seule
  (`url.<base>.insteadOf` et fichiers du helper `store`, dont
  `~/.git-credentials`). Un `glpat-` existant suffit donc à lister les projets
  et à cloner sans ressaisir de token ; le secret reste en mémoire, n'est ni
  copié dans le keychain, ni journalisé. Un identifiant GitHub n'est jamais
  confondu avec GitLab, et une instance configurée n'est jamais basculée vers
  un autre hôte.
- **Sélecteur de dossier natif pour le clone** : le champ de destination
  propose « Parcourir… » (sélecteur de dossiers de l'OS) et ajoute le nom du
  dépôt au dossier choisi ; la saisie manuelle reste possible.

### Modifié

- **Merge possible avec des changements en cours** : glisser une branche sur une
  autre fusionne désormais même avec des modifications non commitées. Les
  changements suivis sont stashés automatiquement (`BeeBranch auto-stash …`),
  le merge s'exécute, puis le stash est réappliqué immédiatement. Si le merge
  ou la réapplication entre en conflit, le stash est conservé et son sélecteur
  est affiché ; l'undo réapplique le stash au lieu de perdre les modifications.
  Le rebase reste refusé sur un worktree sale.
- **Graphe et branches au plus près de GitKraken** : chaque commit est une
  bande teintée par la couleur de sa branche, les références deviennent des
  pastilles colorées par type (branche locale, distante, tag, HEAD), plusieurs
  références s'affichent côte à côte avec un `+N` pour le reste, les nœuds ont
  un anneau qui les détache des lanes (halo d'accent pour HEAD) et la colonne
  des branches s'adapte à la longueur des libellés sans écraser le message.

### Corrigé

- **Modifications locales visibles sans fetch** : le veilleur de fichiers
  invalide désormais l'état du dépôt, pas seulement la copie de travail, pour
  chaque écriture de fichier et chaque modification de l'index. Le résumé
  « Modifications locales » (préparé/modifié/nouveau) et la barre d'état se
  rafraîchissent donc dès qu'un fichier est modifié ou qu'un `git add` externe
  est exécuté, sans rafraîchissement manuel.

### Vérifié

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D
  warnings`, `cargo test --workspace` : 367 tests verts.
- `npm run build`, `npm run lint`, `npm run ui:smoke` : colonnes
  redimensionnables et mémorisées, colonne Date, sélection multiple et
  comparaison A → B, rafraîchissement du résumé après un `repo://changed` de
  type worktree, captures graphe et diff.
- `npm run audit:telemetry` : aucune référence télémétrie.
- `./target/debug/beebranch --version` répond `BeeBranch 0.5.0`.

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
