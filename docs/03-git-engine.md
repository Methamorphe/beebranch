# 03 — Moteur Git CLI

## 1. Invariants

1. **Un seul point d'entrée** : `crates/git::process`. Aucun autre code ne lance `git`.
2. **Jamais de shell.** `std::process::Command` / `tokio::process::Command` avec `arg()`.
3. **Formats machine-readable** partout où c'est possible.
4. **Aucune supposition sur la configuration utilisateur.** On lit `git config` et on respecte hooks, LFS, signatures, credential helpers, `core.autocrlf`, `core.fsmonitor`, `pull.rebase`.
5. **Aucune mutation non sérialisée** par dépôt.
6. **Aucune erreur avalée**, aucun `stderr` tronqué sans le signaler.
7. **Aucune écriture dans le dépôt** hors commande Git demandée.
8. **Aucun contournement de hook** sans action explicite de l'utilisateur.
9. **Aucune sauvegarde applicative.** Les actions destructives sont irréversibles, confirmées, et ne suppriment jamais de fichier non suivi.

## 2. Construction de processus

```rust
struct CommandSpec {
    repo: RepoPath,
    program: GitProgram,          // résolu une fois (PATH ou override)
    subcommand: GitSubcommand,    // allowlist
    args: Vec<OsString>,          // jamais interprétés par un shell
    env: Vec<(OsString, OsString)>,
    stdin: StdinMode,             // null | pipe | file
    timeout: Option<Duration>,
    capture: CaptureMode,         // bounded stdout/stderr
    operation: OperationContext,
}
```

Règles :

- `git -C <worktree> [global opts] <subcommand> [args] -- <paths>`.
- Options globales fixes : `--no-pager`, `-c color.ui=false`, `-c core.quotepath=false` (chemins), `--no-optional-locks` pour les lectures.
- `GIT_TERMINAL_PROMPT=0` pour échouer au lieu de bloquer sur une saisie.
- `GIT_PAGER=cat`, `PAGER=cat`.
- `stdout`/`stderr` bornés (valeur configurable, 16 Kio par défaut pour les erreurs, streaming non borné pour les opérations longues).
- `stdin` fermé sauf besoin explicite (credential helper, éditeur).
- Timeout : 30 s pour les lectures/écritures locales ; aucun timeout par défaut pour fetch/push/clone (heartbeat de progression à la place).
- Windows : `CREATE_NO_WINDOW`.
- Le programme `git` est résolu au démarrage (`git --version`), avec override dans les réglages.

### Environnement

| Variable | Politique |
|---|---|
| `PATH`, `HOME`, `USERPROFILE` | héritées |
| `SSH_AUTH_SOCK`, `GIT_SSH_COMMAND` | héritées (respect de la config SSH utilisateur) |
| `GIT_TERMINAL_PROMPT` | forcée à `0` |
| `GIT_PAGER`, `PAGER` | forcées à `cat` |
| `LC_ALL` | non forcée ; les formats parsés sont indépendants de la locale |
| `GIT_CONFIG_*` | non héritées si elles permettent d'injecter une configuration arbitraire ; liste blanche stricte |
| Secrets | jamais en argument ; voir §13 |

## 3. Détection de capacité

Au premier usage :

- `git --version` → version parsée.
- `git lfs version` → disponibilité LFS.
- Options critiques vérifiées par version documentée, avec tests :
  - `status --porcelain=v2` (≥ 2.11) ;
  - `switch` / `restore` (≥ 2.23) ;
  - `worktree list --porcelain` (≥ 2.7) ;
  - `rebase --update-refs` (≥ 2.38, optionnel).

Version minimale décidée : **Git ≥ 2.34**, cible et tests sur **2.56.0** ([ADR-0007](adr/0007-version-baseline.md)). En dessous : message bloquant avec version détectée. Les fonctionnalités optionnelles sont désactivées par capacité, pas par version codée en dur.

## 4. Commandes de lecture

Toutes les commandes de cette section utilisent `--no-optional-locks` et n'écrivent pas dans le dépôt.

### Découverte

```text
git -C <path> rev-parse --show-toplevel --absolute-git-dir --git-common-dir
                        --is-bare-repository --is-inside-work-tree
```

Résultat : worktree, git dir, common dir, bare, inside-worktree. Le common dir permet de rattacher les worktrees à la même session logique.

### Status

```text
git -C <repo> --no-optional-locks status --porcelain=v2 -z --branch
    --untracked-files=all --ignore-submodules=none --find-renames
```

Parsing :

- `# branch.oid`, `# branch.head`, `# branch.upstream`, `# branch.ab`.
- `1` : changement ordinaire (XY, submodule, modes, path).
- `2` : renommage/copie (deux chemins séparés par NUL).
- `u` : conflit (XY, modes, stages, path).
- `?` : non suivi ; `!` : ignoré (seulement si demandé).
- `-z` : aucun échappement de chemin, tout est NUL-terminé.

Le status complet peut être coûteux ; il est exécuté en tâche de fond, avec invalidation par watcher, jamais à chaque frame.

### Refs

```text
git -C <repo> for-each-ref --format='%(refname)%09%(objectname)%09%(objecttype)%09%(upstream)%09%(HEAD)%09%(symref)'
```

Les noms de refs ne peuvent pas contenir de tabulation ni de contrôle ; parsing par champs. Les refs distantes sont regroupées par remote.

### Log (page de graphe)

```text
git -C <repo> --no-optional-locks log <order> --parents
    --format='%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s'
    --max-count=<N> [<cursor>]
```

- `<order>` : `--date-order` par défaut (activité récente, parents après enfants) ; `--topo-order` disponible si la lisibilité des lanes le justifie. Le choix est mesuré (stabilité des lanes, coût sur gros historiques).
- `%s` est le sujet (une ligne) ; le corps n'est chargé qu'à la demande.
- Les champs sont séparés par `0x1F` (unit separator), les enregistrements par `\n`.
- Pagination par **fenêtre croissante** : `N = 500`, puis 1 000, 2 000, 4 000… avec cache. Les sauts profonds utilisent `--skip` et sont mesurés ; aucun chargement complet implicite.
- Topologie (parents) calculée côté Rust à partir de `%P` ; les lanes sont attribuées dans `git::log`.

### Détail de commit

```text
git show -s --format='%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%B' <sha>
git diff-tree --no-commit-id --name-status -r -z <sha>
git diff-tree --no-commit-id --numstat -z <sha>
```

Le corps est borné ; les fichiers sont paginés. Pour un commit de merge, le diff par défaut est celui du premier parent, avec possibilité de choisir le parent.

### Diff

```text
git -C <repo> diff --no-color --no-ext-diff --no-textconv --unified=<n>
    [--cached] <base> [<target>] -- <path>
```

- `--no-ext-diff` et `--no-textconv` pour un rendu déterministe ; les diff tools externes sont une action séparée.
- Parseur unifié Rust : hunks, lignes, absence de newline final, binaire (`Binary files ... differ`).
- Plafond par fichier (taille et nombre de lignes) ; au-delà, message explicite et ouverture externe possible.
- Untracked : lecture directe du fichier avec plafond, jamais via un diff synthétique fragile.

### Blame et historique de fichier

```text
git blame --line-porcelain -- <path>
git log --follow --name-status --format='...' -- <path>
```

`--follow` ne fonctionne que pour un seul chemin ; le documenter dans l'UI.

## 5. Commandes de mutation

Toute mutation passe par la file du dépôt et un **préflight**.

| Action | Commande | Préflight |
|---|---|---|
| Stage chemins | `git add -A -- <paths>` | chemins valides, pas de `.git` |
| Unstage | `git restore --staged -- <paths>` | index non vide |
| Discard worktree | `git restore --worktree -- <paths>` | confirmation explicite ; action irréversible |
| Commit | `git commit -F <tmp> [--amend] [--cleanup=strip]` | identité configurée, index non vide, hooks |
| Switch | `git switch <branch>` / `git switch -c <branch> [<start>]` | worktree compatible, pas d'opération en cours |
| Delete branch | `git branch -d/-D <branch>` | non courante, mergée ou confirmation forte |
| Rename branch | `git branch -m <old> <new>` | nom valide, pas de collision |
| Fetch | `git fetch --prune --progress <remote>` | remote existe |
| Pull | `git pull --progress [--ff-only\|--rebase]` | worktree propre, upstream |
| Push | `git push --progress <remote> <ref>` | upstream, non-fast-forward détecté |
| Force push | `git push --force-with-lease=<ref>:<expected>` | confirmation explicite, ancien SHA enregistré |
| Merge | `git merge --no-edit <ref>` | worktree propre, pas d'opération |
| Rebase | `git rebase <upstream>` | worktree propre, pas de merge commits non gérés |
| Cherry-pick | `git cherry-pick <sha>...` | worktree propre |
| Revert | `git revert --no-edit <sha>...` | worktree propre |
| Reset | `git reset --soft\|--mixed\|--hard <ref>` | confirmation forte ; `--hard` irréversible |
| Stash push | `git stash push -m <msg> [-- <paths>]` | — |
| Stash apply/pop | `git stash apply\|pop <ref>` | conflits possibles |
| Worktree add | `git worktree add <path> <ref>` | chemin absent |
| Worktree remove | `git worktree remove <path>` | pas de modifications non commitées |
| Tag | `git tag -a <name> -m <msg> <ref>` | nom valide, pas de collision |

### Staging partiel

Le staging par hunk/ligne repose sur la génération d'un patch unifié puis :

```text
git apply --cached [--reverse] --recount --whitespace=nowarn <patch>
```

- Le patch est généré depuis `git diff` (working tree) ou `git diff --cached` (index) avec le contexte exact.
- Un patch de ligne est construit en réduisant les hunks sélectionnés ; les numéros de ligne sont recalculés.
- `--recount` tolère les en-têtes de comptage ; il ne doit pas masquer une erreur de contexte.
- Tests obligatoires : CRLF, absence de newline final, fichier renommé, mode `100755`, chemin Unicode, contexte ambigu, patch vide.
- En cas d'échec : aucune modification partielle acceptée ; l'index est relu et l'erreur remontée.

### Discard

- Action **irréversible** : aucune copie applicative n'est conservée.
- Confirmation explicite avec le diff exact et le nombre de fichiers concernés.
- Fichier suivi : vérification d'empreinte, puis `git restore --worktree`.
- Fichier stagé + worktree : restore des zones choisies, après confirmation.
- Fichier non suivi : **jamais supprimé par l'application** ; proposer d'ouvrir le dossier ou de l'ajouter au `.gitignore`.
- Hunk : reverse-apply du patch sélectionné sur le worktree, avec vérification d'empreinte avant/après.
- Un discard n'est jamais exécuté si le fichier a changé depuis l'affichage du diff (empreinte).

### Rebase interactif (P2)

- Le plan est validé contre `git rev-list --reverse --no-merges <upstream>..HEAD` :
  mêmes commits, unicité, ordre libre, `drop` explicite.
- Le todo est écrit dans un répertoire temporaire ; `GIT_SEQUENCE_EDITOR` est
  réglé sur `cp '<todo>'`, donc Git installe notre plan sans éditeur interactif.
- `reword` et `squash` utilisent `exec git commit --amend -F <message>`, ce qui
  évite `GIT_EDITOR` et rend les messages déterministes.
- Un conflit est un état, pas une erreur opaque ; `--continue`, `--skip` et
  `--abort` restent explicites.

### Résolution de conflits 3 panneaux (P2)

- `git show :1:path`, `:2:path`, `:3:path` fournissent base/ours/theirs.
- Le fichier de travail est lu et écrit de façon atomique (fichier temporaire
  puis `rename`), en préservant LF/CRLF détectés.
- Les binaires et fichiers > 8 Mio ne sont jamais décodés ; l'UI l'explique.
- Les marqueurs restants sont refusés sauf édition brute explicite.
- `git add -- path` marque le conflit résolu.

### Patches (P2)

- Création depuis worktree, index, commit (`git show --format= --patch`) ou
  plage de commits.
- Les patchs binaires sont refusés explicitement.
- Application en deux phases : `git apply --check` puis `git apply` ; un
  conflit de vérification laisse le worktree intact.

## 6. Opérations longues, streaming et annulation

| Opération | Streaming | Annulation |
|---|---|---|
| `clone` | stderr (progress) | SIGTERM, puis kill après 5 s ; répertoire partiel marqué |
| `fetch` | stderr (progress) | SIGTERM ; état distant revalidé après |
| `push` | stderr (progress) | SIGTERM ; **le push peut avoir abouti** → `ls-remote` pour vérifier |
| `pull` | stderr | SIGTERM ; état local revalidé |
| `merge`/`rebase`/`cherry-pick` | stdout/stderr | Pas d'annulation à mi-commande ; proposer abort après état stable |

Règles :

- Aucun `kill -9` immédiat : arrêt gracieux, puis forcé.
- Sur Windows, `Child::kill()` ; sur Unix, signal au groupe de processus si un helper est lancé.
- Toute annulation produit un `AppError { code: "op.cancelled" }` et un rafraîchissement d'état.
- Les hooks peuvent lancer des processus enfants ; le timeout et l'annulation doivent les couvrir.

## 7. États intermédiaires et reprise

Chemins résolus via `git rev-parse --git-path <name>` (indispensable pour les worktrees).

| État | Détection | Actions proposées |
|---|---|---|
| Merge | `MERGE_HEAD` | continue, abort, résoudre |
| Rebase (merge) | `rebase-merge/` | continue, skip, abort |
| Rebase (apply) | `rebase-apply/` | continue, skip, abort |
| Cherry-pick | `CHERRY_PICK_HEAD` | continue, skip, abort |
| Revert | `REVERT_HEAD` | continue, skip, abort |
| Sequencer | `sequencer/todo` | continuer la séquence |
| Bisect | `BISECT_LOG`, `BISECT_START` | reset, terminer |
| Conflits | `status` entrées `u` | ouvrir, marquer résolu |
| Verrous | `index.lock`, `HEAD.lock` | expliquer, proposer de vérifier l'absence d'un autre processus |

Au démarrage d'une session, l'état est calculé et affiché **avant** toute action. Aucune action destructive n'est permise tant qu'un état intermédiaire n'est pas compris.

## 8. Conflits

- `git status --porcelain=v2 -z` fournit les chemins en conflit.
- Les versions sont lues via `git cat-file` / `git show :1:path`, `:2:path`, `:3:path` (base, ours, theirs) — uniquement pour l'éditeur 3 panneaux (P2).
- Résolution : écriture du fichier de travail, puis `git add -- <path>`.
- `continue` : `git merge --continue`, `git rebase --continue`, `git cherry-pick --continue`.
- `abort` : commande correspondante, avec vérification qu'aucune modification utilisateur non sauvegardée ne sera perdue.
- En P1, l'édition se fait dans l'éditeur externe ; l'app suit l'état et permet `add`, `continue`, `abort`.

## 9. Rebase interactif

Le todo est généré par l'application, jamais édité à la main dans un éditeur interactif.

```text
GIT_SEQUENCE_EDITOR=<helper> GIT_EDITOR=<helper> \
git -c sequence.editor=<helper> rebase -i --autosquash <base>
```

- Le helper (`beebranch-editor`) reçoit le chemin du fichier todo et un mode (`sequence` ou `message`).
- Il lit un plan JSON depuis un fichier temporaire créé par l'application (permissions 0600) et écrit le todo.
- Pour `reword`, le helper écrit le message préparé ; pour `squash`, le message est composé par l'application.
- Le plan est validé avant lancement : pas de `drop` du commit de base, pas de todo vide, pas de référence inconnue.
- En cas de conflit : état `Rebase`, résolution, `--continue`/`--abort`.
- Aucun parsing du todo généré par Git n'est utilisé comme source de vérité ; l'application conserve son plan.

## 10. Worktrees

- `git worktree list --porcelain` liste les worktrees (chemin, HEAD, branche, bare, locked, prunable).
- Une session est identifiée par le **worktree**, mais partage le common dir.
- Les opérations de refs sont communes ; les opérations d'index/worktree sont locales au worktree.
- Création : `git worktree add <path> <ref>` ; refus si le chemin existe ou est déjà enregistré.
- Suppression : préflight (modifications non commitées), puis `git worktree remove` ; `--force` seulement avec confirmation.
- Lock/unlock : `git worktree lock/unlock`.
- Les caches de status et d'index sont indexés par `(worktree, generation)`.

## 11. Submodules, LFS, signatures, SSH

| Sujet | Politique |
|---|---|
| Submodules | Déléguer à `git submodule` ; statuts via `git submodule status --recursive` ; ne pas parser `.gitmodules` comme source de vérité |
| LFS | Détecter `git lfs` ; les filtres sont appliqués par Git ; ne jamais lire un pointer file comme un fichier normal sans signaler LFS |
| Signature | Respecter `commit.gpgsign`, `user.signingkey`, `gpg.format` ; ne jamais forcer |
| SSH | Utiliser l'agent, `~/.ssh/config`, `GIT_SSH_COMMAND` si défini ; ne pas générer de clés au MVP |
| HTTPS | Credential helper fourni par l'application, token lu dans le keychain ; jamais dans l'URL |
| Hooks | Exécutés par Git ; sortie affichée ; échec bloquant sauf action explicite |

### Credential helper HTTPS

- `git -c credential.helper= -c credential.helper=<chemin du helper>`.
- Le helper reçoit `get`/`store`/`erase` sur stdin et renvoie `username` + `password` (token).
- Le helper lit le token dans le keychain via l'instance GitLab associée ; aucun secret en argv ni dans l'URL.
- Le remote enregistré reste `https://host/group/project.git`.

## 12. Mapping des erreurs

| Motif / code | Code applicatif | Remédiation |
|---|---|---|
| `not a git repository` | `repo.not_git` | vérifier le chemin |
| `Authentication failed`, `could not read Username` | `auth.failed` | vérifier le token / le helper |
| `Permission denied (publickey)` | `auth.ssh_key` | vérifier l'agent et la clé |
| `Host key verification failed` | `auth.host_key` | vérifier `known_hosts` |
| `non-fast-forward`, `fetch first` | `git.non_fast_forward` | fetch puis merge/rebase |
| `CONFLICT`, exit 1 sur merge/rebase | `git.conflict` | résoudre puis continue |
| `Your local changes would be overwritten` | `git.dirty_worktree` | stash/commit |
| `index.lock` | `repo.busy` | vérifier un autre processus |
| `detected dubious ownership` | `repo.safe_directory` | ajouter `safe.directory` explicitement |
| `unable to auto-detect email address` | `git.identity_missing` | configurer `user.name`/`user.email` |
| `gpg failed to sign` | `git.signing_failed` | vérifier la clé/agent |
| `this operation must be run in a work tree` | `repo.bare` | ouvrir un worktree |
| `no such remote` | `git.remote_missing` | vérifier la configuration |
| `pathspec ... did not match` | `git.pathspec` | vérifier le chemin |
| `untracked working tree files would be overwritten` | `git.untracked_collision` | déplacer manuellement les fichiers concernés |
| `refusing to merge unrelated histories` | `git.unrelated_histories` | décision explicite |
| `You are not currently on a branch` | `git.detached` | créer une branche |
| `unmerged files` | `git.unresolved_conflicts` | résoudre |
| `bad object`, `invalid reference` | `git.bad_ref` | vérifier la ref |
| `shallow` + opération non supportée | `git.shallow_unsupported` | fetch/unshallow |
| inconnu | `git.exit_unknown` | détail brut |

Le mapping est testé avec des dépôts fixtures reproduisant chaque cas.

## 13. Sécurité du moteur

- Allowlist de sous-commandes et d'options ; aucune option arbitraire venue du frontend.
- Les chemins passent après `--` et sont validés (pas de `..` hors dépôt, pas de `.git` interne).
- Les messages de commit et les noms de branches ne sont jamais injectés dans une ligne de commande : ils passent par fichier ou argv.
- Les tokens ne transitent jamais par argv, URL ou variable d'environnement lisible par un autre processus.
- Les sorties sont redactées avant log.
- Les commandes Git sont exécutées avec le répertoire de travail du dépôt, pas avec un `cwd` arbitraire.

## 14. Tests

### Fixtures générées

Un script versionné crée, pour chaque test :

- dépôt linéaire ;
- dépôt avec merges (dont merge de merge) ;
- dépôt avec branches multiples et refs distantes simulées ;
- dépôt avec conflit de merge, de rebase et de cherry-pick ;
- dépôt avec renommage, suppression, mode exécutable, symlink ;
- dépôt avec CRLF, absence de newline final, chemins Unicode ;
- dépôt avec fichiers volumineux et binaires ;
- dépôt avec submodule local ;
- dépôt avec worktrees multiples ;
- dépôt shallow ;
- dépôt avec hooks qui échouent ;
- dépôt avec `index.lock` simulé.

### Niveaux

| Niveau | Contenu |
|---|---|
| Unitaire | parseurs (status, log, diff, refs), construction argv, mapping d'erreurs |
| Intégration | commandes réelles sur fixtures, assertions sur l'état Git résultant |
| Contrat | chaque commande renvoie le type attendu et un code d'erreur stable |
| Plateforme | mêmes tests sur Windows/macOS/Linux |
| Fault injection | permissions, disque plein, interruption, verrou, hook en échec |
| Performance | voir [06-performance](06-performance.md) |

Aucun test ne se contente de vérifier qu'une commande « ne plante pas » : il vérifie l'état du dépôt après l'opération.
