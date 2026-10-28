# 01 — Périmètre produit et inventaire fonctionnel

## 1. Objectif

Construire **BeeBranch**, un client Git desktop professionnel, local-first, destiné aux développeurs de l'entreprise, remplaçant GitKraken au quotidien et intégré à l'instance GitLab self-hosted.

Le produit doit être :

- **rapide** : latence perçue faible, rendu fluide, démarrage maîtrisé ;
- **fiable** : état réel du dépôt toujours visible, aucune perte silencieuse ;
- **dense** : beaucoup d'information utile sans surcharge visuelle ;
- **prévisible** : les actions font ce qu'elles annoncent, les erreurs sont actionnables ;
- **maintenable** : un seul moteur Git, périmètre fermé, peu d'abstractions.

## 2. Utilisateurs et contexte

| Élément | Valeur |
|---|---|
| Utilisateurs | Développeurs de l'entreprise, profils junior à expert |
| Plateformes | Windows, macOS, Linux |
| Hébergement | GitLab self-hosted, URLs et certificats internes |
| Réseau | Peut être restreint ; Git doit fonctionner hors ligne |
| Dépôts | Monorepos, nombreux fichiers, nombreuses branches, submodules, worktrees, LFS |
| Langue de l'UI | Français (extensible i18n plus tard) |

## 3. Principes produit

1. **Local-first.** Git est la source de vérité. Aucune fonctionnalité Git de base ne dépend de GitLab ou d'un compte.
2. **Aucune action destructive silencieuse.** Confirmation, conséquences explicites, préflight.
3. **L'état réel avant l'esthétique.** Un dépôt en conflit, en rebase ou détaché doit être évident.
4. **Densité maîtrisée.** L'information importante est visible ; le bruit est masquable (hide/solo, filtres).
5. **Clavier d'abord, souris ensuite.** Toute action fréquente a un raccourci et une command palette.
6. **Pas de fausse promesse.** Une fonctionnalité n'existe que si le comportement est réel, testé et vérifié.
7. **Intégration native au contexte.** GitLab est un citoyen de première classe, pas un plugin.
8. **Aucune dépendance à l'éditeur.** Pas d'IA, pas de cloud propriétaire, pas de télémétrie intrusive, pas de login obligatoire.
9. **Identité propre.** Ergonomie et densité inspirées de GitKraken, mais aucun asset, icône, logo, palette exacte ou élément de marque GitKraken n'est copié.

## 4. Non-objectifs

- Reproduction exhaustive de GitKraken.
- Copie des assets, icônes, logos, polices ou de la palette exacte de GitKraken.
- Éditeur de code intégré.
- CI/CD exécutée localement.
- Gestion de comptes multi-fournisseurs (GitHub, Bitbucket, Azure) au MVP.
- Fonctionnalités IA, suggestions de code, MCP.
- Dashboards d'équipe cloud, Insights, Automations, Codemaps.
- Gestion de plusieurs instances GitLab par profil au MVP (une instance active à la fois).
- Support des dépôts bare comme dépôt de travail au MVP.

## 5. Définitions

| Terme | Définition |
|---|---|
| **Session de dépôt** | Contexte backend associé à un worktree ouvert : watcher, cache, file de mutations, état Git. |
| **Opération** | Invocation Git suivie : identifiant, commande, durée, sortie, code de sortie, annulation possible. |
| **État Git** | État structurel : normal, merge, rebase, cherry-pick, revert, bisect, détaché, non-né, conflit. |
| **Mutation** | Opération qui modifie refs, index ou working tree. Sérialisée par dépôt. |
| **Préflight** | Vérifications avant mutation (propreté, upstream, conflits, fichiers écrasés). |
| **Action irréversible** | Opération qui ne peut pas être annulée par Git (discard, `reset --hard`, stash drop) ; confirmation obligatoire. |
| **Baseline** | Résultat mesuré de référence pour un scénario de performance. |

## 6. Inventaire fonctionnel priorisé

Chaque fonctionnalité est considérée **non terminée** tant que :

- le comportement réel est implémenté (pas seulement l'UI) ;
- les critères d'acceptation sont couverts par des tests automatisés ou une preuve d'exécution documentée ;
- les cas d'erreur et les états intermédiaires sont traités ;
- les performances respectent le budget du scénario associé, s'il existe.

### P0 — Fondations et validation technique

Objectif : démontrer les composants les plus risqués et fixer les budgets.

| ID | Fonctionnalité | Critères d'acceptation | Dépend de |
|---|---|---|---|
| P0-01 | Shell applicatif Tauri 2 | Lancement sur Windows/macOS/Linux ; préférences persistées ; logs structurés ; error boundary ; aucune télémétrie réseau | — |
| P0-02 | Moteur Git CLI sécurisé | Aucune commande via shell ; argv explicites ; `stdout/stderr/exit code` capturés ; annulation ; file de mutations par dépôt ; erreurs typées ; tests d'intégration sur dépôts réels | P0-01 |
| P0-03 | Ouverture et session de dépôt | Ouverture par sélecteur, chemin, récents ; détection worktree/submodule/bare ; validation du chemin ; session créée et détruite proprement ; dépôt invalide → erreur actionnable | P0-02 |
| P0-04 | Modèle de lecture de base | Refs, status, page de log, détail de commit, diff ; cohérence après modification externe ; pagination ; aucun chargement complet implicite | P0-02 |
| P0-05 | Prototype de graphe virtualisé | Rendu canvas ; topologie correcte sur fixtures de merges ; 200k commits chargés par pages ; scroll fluide mesuré ; mémoire bornée ; aucune régression sur changement de dépôt | P0-04 |
| P0-06 | Prototype de diff viewer | Modes hunk/inline/split ; coloration syntaxique ; navigation entre hunks ; plafond sur gros fichiers ; mesure du temps d'affichage | P0-04 |
| P0-07 | Connexion GitLab self-hosted | URL + préfixe, PAT, keychain, `GET /user`, CA interne, liste de projets, erreurs réseau/TLS/token explicites | P0-01 |
| P0-08 | Harnais de benchmark | Corpus synthétique généré ; scénarios définis ; rapport reproductible ; baseline versionnée ; exécution CI | P0-02, P0-04, P0-05, P0-06 |
| P0-09 | Erreurs et reprise | Taxonomie d'erreurs ; détection des états intermédiaires ; écran de reprise après crash ; aucun état inconnu masqué | P0-02, P0-03 |

**Critère de sortie P0 :** démonstration technique sur au moins deux dépôts réels et un corpus synthétique, avec mesures publiées, erreurs reproductibles traitées, et aucun bloqueur identifié sur le graphe, le diff, GitLab ou la reprise.

### P1 — Premier remplacement utilisable

Objectif : un développeur réalise son workflow quotidien sans revenir à GitKraken.

| ID | Fonctionnalité | Critères d'acceptation | Dépend de |
|---|---|---|---|
| P1-01 | Graphe interactif | Sélection commit/branche ; actions contextuelles (checkout, créer branche, comparer, copier SHA) ; filtres de base ; badge MR ; rafraîchissement après mutation | P0-05 |
| P1-02 | Working tree status | Fichiers staged/unstaged/untracked/ignored/conflits ; renommages ; changement externe détecté ; aucune attente bloquante de l'UI | P0-04 |
| P1-03 | Staging fichier/hunk/ligne | Stage/unstage/discard par fichier, hunk et ligne ; gestion CRLF, absence de newline final, renommages ; discard confirmé ; index cohérent après chaque action | P1-02 |
| P1-04 | Commit et amend | Message, amend, exécution des hooks, affichage de la sortie, refus si hook échoue, signature respectée ; aucun contournement silencieux | P1-03 |
| P1-05 | Branches locales et distantes | Créer, checkout, renommer, supprimer avec préflight, upstream, comparaison ; branche non mergée → confirmation forte | P1-01 |
| P1-06 | Fetch / pull / push | Progression streamée ; annulation ; `force-with-lease` uniquement avec confirmation ; erreurs auth/SSH/non-fast-forward actionnables | P1-05 |
| P1-07 | Merge et rebase standards | Préflight ; merge/rebase avec et sans conflit ; `--abort`/`--continue` ; état intermédiaire visible ; jamais de perte de travail locale | P1-05 |
| P1-08 | Conflits — niveau de base | Liste des fichiers en conflit ; ouverture dans l'éditeur externe ; marquage résolu ; abort/continue ; état cohérent après redémarrage | P1-07 |
| P1-09 | Stash | Créer, lister, appliquer, pop, drop ; stash visible dans le graphe ; conflits de pop signalés | P1-02 |
| P1-10 | Multi-dépôts | Onglets indépendants ; sessions isolées ; changement rapide sans fuite mémoire ni état croisé | P0-03 |
| P1-11 | Recherche de commits | Message, SHA, auteur ; résultats paginés ; profondeur explicite ; aucun blocage sur gros historique | P1-01 |
| P1-12 | GitLab — liste et création de MR | Liste filtrée (mes MR, à reviewer, assignées), détail minimal, création depuis une branche poussée, ouverture navigateur | P0-07 |
| P1-13 | GitLab — statut CI et badge MR | Statut pipeline sur la MR et dans le graphe ; rafraîchissement ; états inconnus gérés | P1-12 |
| P1-14 | Sécurité des opérations destructives | Confirmation avec conséquences exactes ; actions destructives déclarées **irréversibles** ; aucune suppression silencieuse ; fichiers non suivis jamais supprimés par l'application ; refus si état incohérent | P1-03, P1-05, P1-07 |
| P1-15 | Outils externes | Ouvrir éditeur, terminal, diff/merge tool configurés ; échec explicite si absent | P0-01 |
| P1-16 | Création de dépôt local | `git init` sur un dossier absolu, nouveau ou existant non versionné ; branche initiale optionnelle ; refus d'un dépôt existant (y compris bare) ; ouverture immédiate ; fichiers existants conservés et non suivis | P0-03 |

**Critère de sortie P1 :** un développeur volontaire effectue une journée de travail complète (branche, staging partiel, commit, push, MR, review simple, merge) sans GitKraken ni terminal, hors opérations explicitement P2.

### P2 — Parité fonctionnelle quotidienne

| ID | Fonctionnalité | Critères d'acceptation | Dépend de |
|---|---|---|---|
| P2-01 | Rebase interactif | Todo généré et exécuté via Git ; réordonner, pick/reword/squash/drop ; annulation de l'éditeur ; conflits gérés ; aucun todo corrompu | P1-07 |
| P2-02 | Résolution de conflits 3 panneaux | Ours/theirs/base/output ; édition ; marquage résolu ; enregistrement du résultat ; cohérence avec les marqueurs Git | P1-08 |
| P2-03 | Cherry-pick / revert avancés | Sélection multiple, ordre, conflits, continue/abort, historique | P1-07 |
| P2-04 | Worktrees | Lister, créer, ouvrir, lock/unlock, supprimer ; statut par worktree ; sessions isolées ; WIP multiples | P0-03 |
| P2-05 | Historique de fichier et blame | Par fichier et par ligne ; navigation vers commit ; gestion renommages ; performance bornée | P1-01 |
| P2-06 | Command palette | Toutes les actions fréquentes ; recherche floue ; contexte dépôt ; exécution clavier | P1 |
| P2-07 | Raccourcis clavier avancés | Couverture des actions principales ; découvrables ; personnalisables si mesuré utile | P2-06 |
| P2-08 | Recherche approfondie | Chemin, contenu (avec limites), auteur, date ; résultats paginés ; scope explicite | P1-11 |
| P2-09 | GitLab — discussions inline | Lire/écrire des commentaires positionnés sur le diff ; résolution ; états d'erreur | P1-12 |
| P2-10 | GitLab — approvals et merge | Approuver, merger avec stratégie ; feature detection des paliers ; confirmation | P1-12 |
| P2-11 | GitLab — jobs et logs | Liste des jobs, statut, logs paginés ; annulation si supportée | P1-13 |
| P2-12 | Submodules | Panneau, add, init, update, pointer commit, statuts ; opérations déléguées à Git | P0-03 |
| P2-13 | Tags et remotes avancés | Tags annotés, push de tags, gestion des remotes, URLs, prune | P1-05 |
| P2-14 | Profils | Identité Git, préférences, onglets ; une instance GitLab active par profil | P1-10 |
| P2-15 | Patchs | Créer/appliquer un patch ; refus des binaires non supportés ; conflits signalés | P1-03 |

### P3 — Finition — livré et vérifié

Preuves : [reviews/p3-review.md](reviews/p3-review.md).

| ID | Fonctionnalité | Critères d'acceptation | Dépend de |
|---|---|---|---|
| P3-01 | Undo / Redo complet | Matrice de [04-undo-redo](04-undo-redo.md) couverte ; préconditions ; opérations réversibles par Git uniquement ; actions irréversibles refusées ; échecs partiels signalés ; tests de crash | P1-14 |
| P3-02 | Drag & drop avancé | Branches et commits ; preview ; annulation ; aucune mutation ambiguë | P2-01 |
| P3-03 | Design system et thèmes | Direction de [10-design-direction](10-design-direction.md) ; tokens, thèmes clair/sombre, densité, animations non bloquantes | — |
| P3-04 | Optimisations gros dépôts | Gains mesurés sur les scénarios en échec de budget ; aucune régression | P0-08 |
| P3-05 | Workspaces multi-repos | Groupes locaux, fetch/pull multi-dépôts, actions bornées | P1-10 |
| P3-06 | Accessibilité et ergonomie | Navigation clavier, focus, contrastes, lecteurs d'écran sur les vues principales | P2-07 |
| P3-07 | Distribution | Mises à jour signées, packaging par OS, télémétrie absente | P0-01 |

## 7. Parité GitKraken : conserver, améliorer, abandonner

### Conserver

- Lecture immédiate de l'historique, lanes lisibles, refs et merges visibles.
- Actions contextuelles pertinentes au clic droit.
- Staging partiel ergonomique (fichier, hunk, ligne).
- Diff viewer confortable (split/inline/hunk, word diff, navigation).
- Manipulation simple des branches (drag & drop en P3).
- Hide/solo, pin de branche, filtres.
- Multi-dépôts par onglets.
- Command palette, raccourcis.
- Vue MR et statut CI intégrés.

### Améliorer

- Démarrage, réactivité, mémoire.
- Densité d'information et cohérence de navigation.
- Gestion explicite des états intermédiaires.
- Intégration GitLab self-hosted native.
- Messages d'erreur et remédiation.
- Respect strict de la configuration Git existante.

### Abandonner

- IA, suggestions de code, MCP.
- Cloud propriétaire, comptes éditeur, Insights, Automations, Codemaps, Launchpad cloud.
- Télémétrie intrusive.
- Fonctionnalités nécessitant un serveur tiers.
- Reproduction de l'identité graphique et des assets GitKraken.

## 8. Hors périmètre explicite

- Édition de code intégrée.
- Résolution de conflits sémantique au-delà de Git.
- Gestion de plusieurs fournisseurs Git.
- Exécution de pipelines CI locale.
- Gestion de clés SSH complète (génération/upload) au MVP : on utilise l'agent et les clés existants.
- Migration de dépôts, réécriture d'historique de masse, filtrage.
- Support de Git < version minimale décidée.
- Synchronisation cloud des préférences.
