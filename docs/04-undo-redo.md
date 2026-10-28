# 04 — Undo / Redo

## 1. Principes

1. **Aucune sauvegarde applicative.** L'application ne copie ni fichiers du working tree ni index pour restaurer un état antérieur.
2. **Seules les opérations réversibles par Git sont annulables** : refs, commits, index, reflog, objets Git.
3. **Inverse typée.** Chaque annulation est une opération Git précise, avec préconditions vérifiées.
4. **Jamais de `reset --hard` générique.** `reset --hard` n'est utilisé que comme inverse explicite d'une opération qui l'exige, après vérification que le worktree est propre.
5. **Les actions destructives sont irréversibles.** Discard, `reset --hard` et stash drop ne sont pas annulables et exigent une confirmation explicite.
6. **Jamais écraser du travail utilisateur.** Si le dépôt a changé depuis l'opération, l'annulation est refusée.
7. **Pas de fausse promesse.** Une opération non annulable est affichée comme telle.
8. **P3, non bloquant.** Le MVP (P1) assure les confirmations et le préflight ; l'undo/redo complet arrive en P3.

## 2. Modèle

```rust
struct UndoRecord {
    id: UndoId,
    repo_id: RepoId,
    kind: UndoKind,
    payload: serde_json::Value,   // données typées, versionnées
    before: Fingerprint,
    after: Fingerprint,
    created_at: Timestamp,
    state: UndoState,             // Available | Consumed | RestoreFailed | Evicted
}
```

- `before` / `after` décrivent l'état du dépôt autour de l'opération.
- `payload` contient les données nécessaires à l'inverse : refs, SHAs, arbres d'index, messages, chemins.
- Aucun fichier du working tree n'est copié.
- Les arbres d'index sont des objets Git (`git write-tree`), pas des sauvegardes de contenu.
- La pile est bornée (50 opérations), sans quota disque.

## 3. Empreinte et préconditions

```rust
struct Fingerprint {
    head: HeadState,              // branche + sha, ou detached
    index_tree: Oid,              // arbre de l'index (git write-tree)
    status_hash: Sha256,          // hash de `status --porcelain=v2 -z`
    state: RepoState,             // opération en cours, conflits
    refs: BTreeMap<String, Oid>,  // refs touchées par l'opération
    affected_files: BTreeMap<PathBuf, Sha256>,
}
```

Vérifications avant annulation :

1. `id` correspond à la dernière opération annulable.
2. Aucune opération Git en cours (`merge`, `rebase`, `cherry-pick`, `revert`, `bisect`).
3. Aucun verrou (`index.lock`, `HEAD.lock`).
4. `HEAD`, index, status et refs touchées correspondent à `after`.
5. Les fichiers affectés n'ont pas changé depuis l'opération.
6. L'inverse est applicable dans l'état courant (worktree propre si `reset --hard` est nécessaire).

Si une condition échoue : refus explicite, aucune modification, message indiquant quoi a changé.

**Historique déjà partagé.** Si le résultat de l'opération est déjà présent sur une branche de suivi distante, l'annulation est une réécriture locale d'historique. Elle reste possible pour les opérations de la matrice, mais exige une confirmation supplémentaire et un avertissement explicite : le distant n'est pas modifié, et un push ultérieur pourra nécessiter une décision manuelle. Aucune annulation ne pousse automatiquement.

## 4. Matrice de réversibilité

Légende : **Oui** = undo supporté ; **Partiel** = supporté avec conditions ; **Non** = explicitement non annulable.

| Opération | Undo | Inverse | Données capturées | Préconditions principales | Redo |
|---|---|---|---|---|---|
| Commit | Oui | `reset --soft` vers `before`, puis `read-tree` de l'index avant | `before_head`, `after_sha`, arbre d'index avant/après | HEAD == `after`, status inchangé, pas d'opération | Oui |
| Commit --amend | Oui | Idem, avec ancien commit | ancien SHA, nouveau SHA, arbres d'index | HEAD == nouveau SHA, status inchangé | Oui |
| Checkout / switch (propre) | Oui | Revenir à `before` (branche ou detached) | `before_head`, `after_head` | HEAD == `after`, worktree propre | Oui |
| Création de branche | Oui | Supprimer la ref créée | nom, SHA | ref pointe toujours au SHA créé, non courante | Oui |
| Suppression de branche | Oui | Recréer la ref au SHA capturé + upstream | nom, SHA, upstream | ref absente | Oui |
| Renommage de branche | Oui | Renommer dans l'autre sens | ancien/nouveau nom | nouveau nom existe, ancien absent | Oui |
| Merge en cours | Partiel | `git merge --abort` | état Git | `MERGE_HEAD` présent, confirmation (résolutions perdues) | Non |
| Merge commit | Partiel | `reset --hard before` typé, worktree vérifié propre | `before/after`, arbres d'index | HEAD == `after`, worktree propre, pas d'opération | Oui |
| Merge branche→branche avec stash automatique | Partiel | `merge --abort`/`reset --hard before` puis `stash apply --index <SHA>` ; drop seulement si le stash n'avait pas déjà été popé | `before/after`, sélecteur et SHA du stash | HEAD == `after` (ou `MERGE_HEAD` en cours) | Non |
| Rebase en cours | Partiel | `git rebase --abort` | état Git | rebase en cours, confirmation | Non |
| Rebase terminé | Partiel | `reset --hard before` typé, worktree vérifié propre | `before/after`, arbres d'index | HEAD == `after`, worktree propre | Oui |
| Cherry-pick en cours | Partiel | `git cherry-pick --abort` | état Git | séquence en cours, confirmation | Non |
| Cherry-pick terminé | Partiel | `reset --hard before` typé | `before/after`, arbres d'index | HEAD == `after`, worktree propre | Oui |
| Revert terminé | Oui | `reset --hard` typé vers `before` + `read-tree` (le worktree a changé) | `before/after`, arbres d'index | HEAD == `after`, status inchangé | Oui |
| Reset --soft | Oui | Reset soft inverse + `read-tree` | `before/after` HEAD, arbres d'index | HEAD == `after` | Oui |
| Reset --mixed | Oui | Reset mixed inverse + `read-tree` | `before/after` HEAD, arbres d'index | HEAD == `after`, worktree inchangé | Oui |
| **Reset --hard** | **Non** | — | — | — | — |
| **Discard fichier** | **Non** | — | — | — | — |
| **Discard hunk** | **Non** | — | — | — | — |
| Stage / unstage | Non (hors pile) | Action opposée dans l'UI | — | — | — |
| Stash create | Partiel | `git stash apply --index` puis drop si succès exact | stash SHA, message | worktree propre, stash présent | Non |
| **Stash drop** | **Non** | — | — | — | — |
| **Stash apply / pop** | **Non** | — | — | — | — |
| Création de tag | Oui | Supprimer le tag | nom, objet | tag pointe au même objet | Oui |
| Suppression de tag | Oui | Recréer le tag (annoté : message, tagger) | nom, objet, message | tag absent | Oui |
| Ajout de remote | Oui | Supprimer le remote | nom, URLs | remote inchangé | Oui |
| Suppression de remote | Oui | Recréer le remote + refspec | nom, URLs, refspec | remote absent | Oui |
| Fetch | Non | — | — | — | — |
| Push | Non | — | — | — | — |
| Force push | Non | Action distincte « restaurer le distant » | ancien SHA distant | confirmation forte | — |
| Worktree add | Oui | `git worktree remove` | chemin, branche | worktree sans modifications | Oui |
| Worktree remove | Oui | `git worktree add` au même chemin | chemin, ref | chemin libre | Oui |
| Submodule update | Non | — | — | — | — |

### Actions explicitement irréversibles

- `discard` de fichier ou de hunk ;
- `reset --hard` ;
- `stash drop`, `stash apply`, `stash pop` ;
- suppression de fichier non suivi (hors application) ;
- push et force push ;
- fetch ;
- mise à jour de submodule ;
- abandon d'un merge/rebase avec résolutions de conflits non enregistrées ;
- toute opération dont les préconditions ne sont plus vérifiables.

L'UI affiche ces actions comme irréversibles. Aucun bouton « Annuler » ne leur est associé.

## 5. Récupération sans sauvegarde

L'application ne conserve aucune copie. Les possibilités de récupération dépendent de Git :

| Situation | Récupération possible |
|---|---|
| Commit annulé | Objet encore présent ; `git reflog` / SHA |
| Branche supprimée | SHA capturé ; recréer la ref si l'objet existe |
| Merge/rebase annulé | Ancien HEAD dans le reflog |
| Discard | **Aucune** : le contenu non commité est perdu |
| Reset --hard | **Aucune** pour les modifications non commitées |
| Stash drop | **Aucune** garantie : l'objet peut être ramassé par Git |

L'UI doit rendre cette différence explicite avant l'action, pas après.

## 6. Algorithme de restauration

```text
1. Charger UndoRecord.
2. Vérifier l'empreinte (section 3). Échec → refus, aucun effet.
3. Exécuter l'inverse typée, étape par étape :
   a. étape Git (reset, switch, update-ref) ;
   b. restauration d'index via `read-tree` si applicable ;
   c. vérification après chaque étape.
4. Recalculer l'état du dépôt et l'empreinte.
5. Vérifier que l'état obtenu correspond à `before`.
6. Marquer l'opération Consumed ; conserver le redo.
```

### Échec partiel

- Arrêt immédiat, aucune tentative de « réparer » automatiquement.
- État `RestoreFailed` avec :
  - étape atteinte ;
  - commande exacte exécutée ;
  - sortie Git ;
  - suggestion de récupération via `git reflog` ou SHA.
- Aucune sauvegarde n'existe : l'UI ne promet pas de restauration automatique.
- L'utilisateur voit un panneau de récupération, pas un simple toast.

### Crash pendant la restauration

- Chaque étape écrit un marqueur dans le journal SQLite avant et après exécution.
- Au démarrage, une opération `Restoring` est marquée `RestoreInterrupted` et l'état du dépôt est recalculé.
- Aucune donnée n'est restaurée automatiquement.

## 7. Redo

- Le redo n'est proposé que si l'état `before` est toujours exact et que l'action `after` peut être réappliquée sans perte.
- Pour les opérations basées sur des commits, le redo déplace HEAD, restaure l'index et laisse le worktree intact.
- Aucun redo pour les actions irréversibles.
- Un redo qui échoue laisse l'état inchangé et signale l'erreur.

## 8. UI

- Bouton Undo activé uniquement si la dernière opération est dans la matrice **et** si les préconditions sont satisfaites au moment du clic.
- Libellé explicite : « Annuler le commit `a1b2c3d` », « Annuler la suppression de la branche `feature/x` ».
- Refus avec raison : « Le dépôt a changé depuis cette opération ».
- Les actions irréversibles affichent un avertissement avant exécution et n'apparaissent jamais comme annulables.
- Aucune confirmation supplémentaire pour un undo sûr ; confirmation pour un undo qui abandonne des résolutions de conflits.
- Le panneau de récupération est accessible depuis les réglages et après un échec.

## 9. Tests

| Test | Attendu |
|---|---|
| Chaque ligne « Oui » de la matrice, cas nominal | état `before` restauré exactement |
| Chaque ligne « Non » | aucun undo proposé, action signalée irréversible |
| Précondition violée (HEAD changé) | refus, aucun effet |
| Fichier modifié après l'opération | refus |
| Fichier non suivi présent | jamais supprimé par un undo |
| Conflit en cours | undo refusé ou abort explicite |
| Dépôt détaché | checkout inverse correct |
| Index restauré | `git diff --cached` identique à `before` |
| Worktree sale avant un reset inverse | refus |
| Échec partiel simulé | état `RestoreFailed`, commande et SHA affichés |
| Crash entre deux étapes | reprise au démarrage, pas de restauration silencieuse |
| Worktree | undo isolé au bon worktree |
| Branche supprimée puis recréée | refus si le SHA diffère |
| Aucune copie applicative | aucun fichier de working tree créé sous app data |

Les tests utilisent de vrais dépôts et vérifient l'état via Git, pas seulement les réponses de l'application.

## 10. Implémentation P3

- Module `crates/git/src/undo.rs` : empreinte, préconditions, actions typées,
  exécution pas à pas et injection de faute pour les tests.
- Journal SQLite `undo_records` : pile bornée à 50 par dépôt, états
  `available`/`consumed`/`restoring`/`restoreFailed`/`restoreInterrupted`/
  `evicted`, `position`, étape, commande et SHA de récupération.
- Chaque étape est écrite **avant** exécution ; au démarrage, `restoring`
  devient `restoreInterrupted` et n'est jamais rejoué.
- Les mutations réversibles capturent leur empreinte dans la file sérialisée
  du dépôt (`run_undoable_mutation`), puis enregistrent leur inverse typé.
- Un commit utilise `reset --soft` + `read-tree` ; merge, rebase, cherry-pick
  et revert utilisent `reset --hard` typé après égalité d'empreinte (worktree
  propre par construction), jamais un `reset --hard` générique.
- Stash create : `stash apply --index`, vérification du hash de status attendu,
  puis `stash drop` seulement si l'application est exacte.
- Un nouveau record invalide la branche redo (`consumed` → `evicted`).
