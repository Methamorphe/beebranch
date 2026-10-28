# 07 — Fiabilité et sécurité

## 1. Invariants de fiabilité

1. **Aucune opération destructive silencieuse.** Toute action qui peut supprimer du travail est confirmée avec ses conséquences exactes.
2. **L'état réel du dépôt est toujours affiché.** Merge, rebase, cherry-pick, conflit, détaché, verrou : visible avant toute action.
3. **Aucune écriture manuelle dans `.git`.** Uniquement via Git.
4. **Aucune suppression de verrou automatique.** Un `index.lock` est signalé, jamais supprimé sans action explicite et vérification.
5. **Aucune perte silencieuse de fichier non suivi.** L'application ne supprime jamais de fichier non suivi ; le discard ne concerne que le contenu suivi et est explicitement irréversible.
6. **Toute opération partielle est visible et récupérable.** Pas de rollback silencieux.
7. **La configuration Git de l'utilisateur est respectée** (hooks, LFS, signatures, autocrlf, pull.rebase, credential helpers).
8. **Une fonctionnalité n'est pas terminée si son comportement réel n'est pas vérifié.**

## 2. Préflight et confirmations

### Matrice des actions sensibles

| Action | Préflight | Confirmation | Réversible |
|---|---|---|---|
| Discard fichier/hunk | fichier inchangé depuis l'affichage | oui, avec diff | **non** |
| Reset --hard | worktree état, untracked | oui, texte explicite | **non** |
| Suppression de branche | mergée ? courante ? upstream ? | oui ; forte si non mergée | oui (ref/SHA) |
| Force push | upstream, SHA distant attendu | oui, nom de branche à saisir | **non** (action distincte) |
| Suppression de worktree | modifications non commitées | oui | oui (Git refuse si sale) |
| Stash drop | stash sélectionné | oui | **non** |
| Suppression de tag | distant ? | oui | oui (objet) |
| Abort de merge/rebase | résolutions en cours | oui, perte des résolutions | **non** |
| Retrait de remote | refs associées | oui | oui (URL/refspec) |
| Fermeture d'onglet avec opération en cours | opération active | oui | — |

### Règles

- Le préflight est exécuté **immédiatement avant** la commande, pas au moment de l'affichage.
- Les confirmations décrivent l'effet réel : nombre de fichiers, branches, commits, remote concerné.
- Aucun « Ne plus demander » pour les actions destructives.
- Les actions irréversibles sont annoncées comme telles ; aucune sauvegarde applicative n'est créée.
- Les actions réversibles par Git (commit, stage) ne demandent pas de confirmation.
- Un `--force` n'est jamais ajouté implicitement pour faire passer une commande.

## 3. Concurrence et modifications externes

- Une seule file de mutations par dépôt.
- Les lectures sont bloquées pendant une mutation destructive.
- Avant chaque mutation : vérification de l'empreinte (HEAD, index, status, refs concernées).
- Si un autre processus Git agit : `index.lock`/`HEAD.lock` → `repo.busy`, avec explication.
- Le watcher détecte les changements externes et invalide les caches concernés.
- Une réponse de lecture obsolète est ignorée grâce à la génération.
- Aucun verrou applicatif ne remplace les verrous Git ; on ne crée pas de fichier de verrou dans `.git`.

### Course critique

Le préflight ne garantit pas l'absence de course avec un processus externe. La garantie finale est celle de Git (verrous, refus d'écrasement). Les erreurs correspondantes sont mappées et affichées ; l'état est revalidé.

## 4. Reprise après crash

- Journal SQLite : `operation_id`, type, état (`queued`, `running`, `done`, `failed`, `cancelled`, `interrupted`), timestamps, étapes.
- Au démarrage :
  1. les opérations `running` deviennent `interrupted` ;
  2. l'état du dépôt est recalculé ;
  3. les verrous résiduels sont **signalés**, pas supprimés ;
  4. un panneau de reprise propose les actions sûres (`abort`, `continue`, vérifier le remote).
- Un travail non commité n'est jamais restauré automatiquement.
- Aucune sauvegarde applicative n'est conservée ; la récupération repose sur l'état réel du dépôt et le reflog Git.

## 5. Expérience d'erreur

- Message en français, une phrase d'action.
- Cause technique disponible en détail.
- Remédiation concrète (commande Git équivalente, réglage, lien).
- Code stable pour l'UI et les tests.
- Les erreurs réseau ne bloquent jamais l'onglet local.
- Les sorties de hooks sont affichées, pas résumées à « failed ».

## 6. Modèle de menace

| Actif | Menace | Mesure |
|---|---|---|
| Token GitLab | fuite via logs, URL, frontend, crash report | keychain en release, fichier 0600 en build de développement, redaction, jamais dans l'URL |
| Working tree | perte par discard/reset/clean | confirmation explicite, préflight, aucune suppression de fichier non suivi |
| Dépôt | corruption par écriture directe | uniquement Git |
| Configuration locale | exécution de commandes via `.git/config` ou filtres | avertissement à l'ouverture, transparence |
| Contenu GitLab | XSS via Markdown/HTML | rendu Markdown sanitisé, HTML brut interdit, images distantes bloquées par défaut |
| Dépendances | compromission | versions épinglées, audit, surface minimale |
| Réseau | MITM | TLS vérifié, CA explicite |
| Binaire | mise à jour malveillante | signature, vérification |

### Configuration de dépôt exécutable

Un dépôt peut contenir une configuration locale (`filter.*.clean/smudge`, `core.fsmonitor`, `core.sshCommand`, `credential.helper`) qui lance des commandes lors d'opérations Git. À l'ouverture :

- détecter les clés locales qui définissent une commande externe ;
- afficher un avertissement listant les clés et les valeurs ;
- ne pas exécuter de commande d'ouverture ;
- laisser l'utilisateur continuer ou ouvrir en lecture seule ;
- ne jamais modifier la configuration sans action explicite.

Les hooks ne sont pas versionnés, mais peuvent exister localement. Leur sortie est toujours affichée.

### Contenu distant

- Markdown rendu avec un sanitizer ; aucune balise HTML brute.
- Images distantes bloquées par défaut (évite le tracking IP) ; activation explicite par instance ou par MR.
- Liens ouverts dans le navigateur système, schémas `https` uniquement.
- Aucune exécution de script dans la webview.

## 7. Secrets

- PAT et secrets dans le keychain OS pour les builds release.
- Builds de développement : `secrets-dev.json` (0600) dans le dossier de données.
  macOS indexe l'ACL du keychain sur la signature du binaire ; chaque
  recompilation d'un binaire non signé invalide « Toujours autoriser » et
  provoque une demande de mot de passe à chaque lancement. Une migration
  one-shot lit le token existant (au plus une dernière autorisation), le copie
  dans le fichier puis ne relit plus le keychain. Le fichier de développement ne
  doit jamais être utilisé en release.
- API backend uniquement ; le frontend reçoit un booléen « connecté », jamais le token.
- Redaction centralisée : `PRIVATE-TOKEN`, `Authorization`, `user:pass@`, paramètres `access_token`, `private_token`.
- Les erreurs Git peuvent contenir des URLs avec credentials : redaction avant affichage/log.
- Les crash reports et exports de diagnostic sont filtrés.
- Rotation/suppression du token : action explicite dans les réglages.

## 8. Exécution des commandes

- Allowlist de sous-commandes et d'options.
- Aucun `sh -c`, `cmd /c`, `powershell`.
- Aucune interpolation de message, nom de branche ou chemin dans une chaîne de commande.
- Les chemins sont passés en `OsString` et après `--` quand applicable.
- Les options venant du frontend sont validées par type (enum), pas par chaîne libre.
- Les commandes sont exécutées dans le répertoire du worktree, jamais dans un `cwd` arbitraire.
- Les variables d'environnement permettant une injection de configuration sont filtrées.

## 9. TLS et réseau

- Vérification TLS active par défaut.
- CA interne importable (PEM), stockée localement, associée à l'instance.
- Aucun réglage « ignorer TLS » au MVP.
- Proxy explicite ou variables standard, documenté.
- Timeouts réseau et backoff ; pas de retry sur les mutations non idempotentes.

## 10. Webview

- CSP restrictive : `default-src 'self'` ; pas de script distant ; pas de `unsafe-eval`.
- Aucun contenu distant chargé dans la webview en dehors des images explicitement autorisées.
- Isolation des commandes Tauri par capabilities minimales.
- Désactivation des APIs non utilisées (fs, shell, http) côté frontend.
- Liens externes via une allowlist de schémas.

## 11. Dépendances et chaîne de build

- Versions épinglées (`Cargo.lock`, lockfile frontend).
- Audit régulier (`cargo audit`, audit npm).
- Nombre de dépendances directes minimisé ; justifier chaque ajout.
- Build reproductible autant que possible.
- Binaires signés et notarisation macOS/Windows.

## 12. Tests de fiabilité et de sécurité

| Test | Attendu |
|---|---|
| Kill du processus pendant fetch | état signalé, dépôt récupérable, pas de verrou supprimé automatiquement |
| Kill pendant commit | état recalculé, aucun fichier perdu |
| Action irréversible | aucun undo proposé, confirmation explicite, aucune copie créée |
| Disque plein | erreur actionnable, aucun fichier partiel laissé par l'application |
| Permissions refusées | erreur actionnable, pas de retry infini |
| `index.lock` présent | `repo.busy`, pas de suppression |
| Hook en échec | sortie affichée, commit non créé |
| Signature absente | erreur explicite, pas de contournement |
| Token expiré | événement d'auth, vues en cache |
| TLS auto-signé non importé | erreur TLS, pas de bypass |
| Markdown malveillant | aucun script exécuté, aucun HTML brut |
| Dépôt avec filtre local | avertissement, aucune exécution implicite |
| Force push | confirmation par saisie, ancien SHA enregistré |
| Export de diagnostics | aucun token, aucune URL avec credentials |
| Plateformes | mêmes tests sur Windows/macOS/Linux |

Les tests de sécurité vérifient les artefacts (logs, exports, base SQLite), pas seulement l'UI.

## P3 — Undo, distribution et absence de télémétrie

- **Undo** : journal SQLite `undo_records`, empreintes HEAD/index/status/refs/
  fichiers, préconditions vérifiées avant toute mutation. Chaque étape est
  journalisée avant exécution ; un crash marque `restoreInterrupted` et ne
  rejoue rien. Aucune copie de worktree n'est créée.
- **Mises à jour** : artefacts signés minisign. Le plugin Tauri vérifie la
  signature avant installation ; une signature absente ou invalide retourne
  `update.signature_invalid`. Le manifeste `latest.json` n'est jamais exécuté.
  Le rollback utilise `rollback.json`, également signé, avec confirmation.
- **Packaging** : macOS signé/notarisé (hardened runtime + entitlements),
  Windows signé (Authenticode, timestamp), Linux `.deb`/`.rpm`/AppImage. La CI
  de release vérifie la signature de chaque plateforme avant publication.
- **Aucune télémétrie** : audit `scripts/audit-no-telemetry.mjs` sur les
  sources ; seules les connexions GitLab (configurées par l'utilisateur), Git
  (remotes) et le manifeste de mise à jour signé sont possibles. Aucun envoi
  sans action utilisateur.
