const messages = {
  'workbench.action.cherryPick': 'Cherry-pick',
  'workbench.action.clear': 'Vider',
  'workbench.action.revert': 'Revert',

  'workbench.diff.calculating': 'Calcul du diff…',
  'workbench.diff.empty.body':
    "Le diff s’ouvre depuis le status, la recherche, ou le détail d’un commit.",
  'workbench.diff.empty.title': 'Sélectionnez un fichier ou un commit',
  'workbench.diff.source.commit': 'Commit {sha}',
  'workbench.diff.source.index': 'Index (préparé)',
  'workbench.diff.source.none': 'Aucune sélection',
  'workbench.diff.source.worktree': 'Modifications locales',

  'workbench.empty.noRepo.body': 'Ouvrez un dépôt avec la barre ci-dessus.',
  'workbench.empty.noRepo.title': 'Aucun dépôt ouvert',

  'workbench.error.checkoutBlocked':
    'Terminez l’opération Git et résolvez les conflits avant de changer de branche.',
  'workbench.error.clipboardUnavailable':
    'Presse-papiers indisponible : autorisez l’accès et réessayez.',
  'workbench.error.integrationImpossible': 'Intégration impossible pour ces branches.',
  'workbench.error.localBranchAlreadyTracks':
    'La branche locale « {name} » existe déjà avec un autre suivi. Sélectionnez-la directement ou configurez son upstream dans Branches.',
  'workbench.error.mergeRequestUnavailable':
    'Associez le dépôt à un projet GitLab et poussez la branche.',
  'workbench.error.remoteBranchNameUndetermined':
    'Impossible de déterminer le nom de la branche distante.',
  'workbench.error.unknownRemote':
    'Aucun remote reconnu : ajoutez un remote ou associez un projet GitLab.',

  'workbench.graph.emptyBody':
    'Le dépôt n’a pas encore de commit, ou aucune page n’a pu être lue.',
  'workbench.graph.emptyTitle': 'Historique vide',
  'workbench.graph.filterAll': 'Toutes les branches et tags',
  'workbench.graph.filterAriaLabel': 'Filtrer le graphe par branche',
  'workbench.graph.filterCurrent': 'Branche courante',
  'workbench.graph.multiSelect': 'Sélection multiple',
  'workbench.graph.optionsLabel': 'Options d’affichage du graphe',
  'workbench.graph.resetColumns': 'Réinitialiser les colonnes',
  'workbench.graph.staged.one': '{count} préparé(s)',
  'workbench.graph.staged.other': '{count} préparé(s)',
  'workbench.graph.unstaged.one': '{count} modifié(s)',
  'workbench.graph.unstaged.other': '{count} modifié(s)',
  'workbench.graph.untracked.one': '{count} nouveau(x)',
  'workbench.graph.untracked.other': '{count} nouveau(x)',
  'workbench.graph.worktreeStatus': 'En cours',
  'workbench.graph.worktreeTitle': 'Modifications locales',

  'workbench.inspector.closeWorktreeAriaLabel': 'Fermer la préparation du commit',
  'workbench.inspector.resizeLabel': 'Redimensionner le panneau latéral',
  'workbench.inspector.worktreeAriaLabel': 'Préparation du prochain commit',

  'workbench.integration.alreadyIntegrated':
    '{target} contient déjà tous les commits de {source}.',
  'workbench.integration.checkoutRequired': '{target} sera extraite pendant l’opération',
  'workbench.integration.commitsBehind.one': '{count} commit(s) de retard',
  'workbench.integration.commitsBehind.other': '{count} commit(s) de retard',
  'workbench.integration.commitsToIntegrate.one': '{count} commit(s) de {source} à intégrer',
  'workbench.integration.commitsToIntegrate.other': '{count} commit(s) de {source} à intégrer',
  'workbench.integration.currentBranch': 'branche courante : {branch}',
  'workbench.integration.dialogMerge': 'Fusionner {source} dans {target}',
  'workbench.integration.dialogRebase': 'Rebaser {source} sur {target}',
  'workbench.integration.during.merge': 'la fusion',
  'workbench.integration.during.rebase': 'le rebase',
  'workbench.integration.fastForwardHint':
    'Avance rapide si possible, sinon commit de fusion',
  'workbench.integration.fastForwardImpossible': 'avance rapide impossible',
  'workbench.integration.fastForwardNoMerge': 'fast-forward, aucun commit de fusion',
  'workbench.integration.mergeAction': 'Fusionner',
  'workbench.integration.mergeCommitInstead':
    'commit de fusion créé au lieu d’un fast-forward',
  'workbench.integration.missingCommits.one': '{count} commit de {source} manque dans {target}',
  'workbench.integration.missingCommits.other':
    '{count} commits de {source} manquent dans {target}',
  'workbench.integration.noMutation':
    '{parts}. {operation} sans mutation avant confirmation.',
  'workbench.integration.nothingToIntegrate': 'rien à intégrer',
  'workbench.integration.operation.merge': 'Fusion',
  'workbench.integration.operation.rebase': 'Rebase',
  'workbench.integration.rebaseAction': 'Rebaser',
  'workbench.integration.sameCommit':
    '{target} et {source} pointent sur le même commit.',
  'workbench.integration.stashRequired':
    'modifications locales stashées puis restaurées après la fusion',
  'workbench.integration.strategyFastForward': 'Avance rapide, sans commit de fusion',
  'workbench.integration.strategyLegend': 'Stratégie de fusion',
  'workbench.integration.strategyMergeCommit': 'Commit de fusion',
  'workbench.integration.strategyMergeNote':
    'Conserve la jonction des deux branches dans le graphe.',
  'workbench.integration.strategyUpToDate':
    '{target} pointe sur le dernier commit de {source}.',
  'workbench.integration.untrackedLeft': 'fichiers non suivis laissés en place',

  'workbench.menu.amendCommit': 'Amender ce commit…',
  'workbench.menu.amendTitle': 'Amender HEAD réécrit l’historique',
  'workbench.menu.checkout': 'Checkout',
  'workbench.menu.cherryPickCommit': 'Cherry-picker ce commit',
  'workbench.menu.compareCurrentBranch': 'Comparer à la branche courante',
  'workbench.menu.copyCommitLink': 'Copier le lien du commit',
  'workbench.menu.copyPatch': 'Copier le patch pour partage',
  'workbench.menu.copySha': 'Copier le SHA',
  'workbench.menu.createAnnotatedTagHere': 'Créer un tag annoté ici…',
  'workbench.menu.createBranchHere': 'Créer une branche ici…',
  'workbench.menu.createPatch': 'Créer un patch depuis ce commit…',
  'workbench.menu.createTagHere': 'Créer un tag ici…',
  'workbench.menu.createWorktreeHere': 'Créer un worktree ici…',
  'workbench.menu.detachedHead': 'HEAD détachée sur ce commit',
  'workbench.menu.dragDrop': 'Glisser-déposer',
  'workbench.menu.openMergeRequest': 'Ouvrir une merge request',
  'workbench.menu.recognizedRemoteTitle':
    'Nécessite un remote reconnu ou un projet GitLab associé',
  'workbench.menu.remoteCheckoutTitle':
    'Crée une branche locale qui suit la branche distante',
  'workbench.menu.resetCurrent': 'Réinitialiser {branch} sur ce commit',
  'workbench.menu.resetHint': 'Recul de {branch} seulement : aucun fichier n’est perdu.',
  'workbench.menu.resetMixed': 'Mixte — vide l’index, garde les fichiers',
  'workbench.menu.resetSoft': 'Douce — garde l’index et les fichiers',
  'workbench.menu.revertCommit': 'Revenir sur ce commit (revert)',
  'workbench.menu.stashApply': 'Appliquer le stash',
  'workbench.menu.stashApplyRemove': 'Appliquer et supprimer le stash',
  'workbench.menu.stashDelete': 'Supprimer le stash',
  'workbench.menu.switchTo': 'Basculer sur {name}',

  'workbench.drop.advance': 'Avancer {target} sur {source}',
  'workbench.drop.advanceTitle': 'Avancer {target} sur {source} sans commit de fusion',
  'workbench.drop.compare': 'Comparer {source} et {target}',
  'workbench.drop.merge': 'Fusionner {source} dans {target}',
  'workbench.drop.mergeTitle':
    'Fusionner {source} dans {target} : avance rapide ou commit de fusion',
  'workbench.drop.rebase': 'Rebaser {source} sur {target}',
  'workbench.drop.rebaseTitle': 'Rebaser {source} sur {target}',

  'workbench.notice.activeBranch': 'Branche active : {branch}',
  'workbench.notice.amended': 'Commit {sha} amendé.',
  'workbench.notice.bothDeleted': 'Branche {name} et {remote}/{branch} supprimées.',
  'workbench.notice.branchCreated': 'Branche {name} créée.',
  'workbench.notice.branchDeleted': 'Branche {name} supprimée.',
  'workbench.notice.branchNameCopied': 'Nom copié : {name}',
  'workbench.notice.branchPushed': 'Branche {branch} poussée vers {remote}.',
  'workbench.notice.branchRenamed': 'Branche {old} renommée en {new}.',
  'workbench.notice.branchReset': '{branch} réinitialisée ({mode}) sur {sha}.',
  'workbench.notice.checkout': 'Checkout {branch}.',
  'workbench.notice.cherryPickDone': 'Cherry-pick terminé.',
  'workbench.notice.conflictDuringIntegration':
    'Conflit pendant {operation} : résolvez les fichiers puis poursuivez.',
  'workbench.notice.detachedCheckout': 'Checkout détaché.',
  'workbench.notice.fastForwardNote': ' (avance rapide)',
  'workbench.notice.filterRemoved': 'Filtre du graphe retiré.',
  'workbench.notice.graphIsolated': 'Graphe isolé sur {branch}.',
  'workbench.notice.integrationApplied': '{operation} de {source} appliqué{note}.',
  'workbench.notice.linkCopied': 'Lien copié : {url}',
  'workbench.notice.localChangesRestored': ' Modifications locales restaurées.',
  'workbench.notice.mergeCommitNote': ' (commit de fusion)',
  'workbench.notice.patchCopied': 'Patch du commit copié pour partage.',
  'workbench.notice.patchSaved': 'Patch enregistré : {path}',
  'workbench.notice.pinned': '{branch} épinglée à gauche du graphe.',
  'workbench.notice.pulledFastForward': 'Pull (fast-forward) de {branch}.',
  'workbench.notice.remoteBranchDeleted': 'Branche distante {remote}/{branch} supprimée.',
  'workbench.notice.revertDone': 'Revert terminé.',
  'workbench.notice.shaCopied': 'SHA copié : {sha}',
  'workbench.notice.stashApplied': 'Stash {selector} appliqué.',
  'workbench.notice.stashAppliedRemoved': 'Stash {selector} appliqué et supprimé.',
  'workbench.notice.stashConflict':
    ' Le stash {selector} n’a pas pu être réappliqué (conflits) et il est conservé.',
  'workbench.notice.stashDropped':
    'Stash {selector} supprimé · SHA {sha} récupérable',
  'workbench.notice.stashPreserved':
    ' Modifications locales conservées dans {selector} ({sha}).',
  'workbench.notice.tagCreated': 'Tag {name} créé.',
  'workbench.notice.unpinned': '{branch} désépinglée.',
  'workbench.notice.upstreamSet': 'Upstream de {branch} : {upstream}.',
  'workbench.notice.worktreeCreated': 'Worktree créé : {path}',

  'workbench.preview.ariaLabel': 'Aperçu des modifications',
  'workbench.preview.closeAriaLabel': 'Fermer l’aperçu',
  'workbench.preview.comparison': 'Comparaison {base} → {target}',
  'workbench.preview.emptyBodyAfterBreak':
    'Préparez les fichiers avec +, puis créez votre commit.',
  'workbench.preview.emptyBodyBeforeBreak':
    'Sélectionnez un fichier pour voir ses modifications.',
  'workbench.preview.emptyTitle': 'Chaque changement compte.',
  'workbench.preview.index': 'Prêt à committer',
  'workbench.preview.loading': 'Chargement des modifications…',
  'workbench.preview.worktree': 'Modification locale',

  'workbench.refMenu.branchAlreadyCheckedOut': 'Branche déjà extraite',
  'workbench.refMenu.compareHead': 'Comparer à HEAD',
  'workbench.refMenu.copyBranchLink': 'Copier le lien de la branche',
  'workbench.refMenu.copyBranchName': 'Copier le nom de la branche',
  'workbench.refMenu.createWorktreeHere': 'Créer un worktree à partir d’ici…',
  'workbench.refMenu.currentSuffix': ' · actuel',
  'workbench.refMenu.deleteBoth': 'Supprimer la branche locale et sa distante…',
  'workbench.refMenu.deleteLocal': 'Supprimer la branche locale…',
  'workbench.refMenu.deleteRemote': 'Supprimer la branche distante…',
  'workbench.refMenu.deleteUpstream': 'Supprimer la branche distante suivie…',
  'workbench.refMenu.localBranch': 'branche locale',
  'workbench.refMenu.noRemoteBranches': 'Aucune branche distante : lancez un fetch.',
  'workbench.refMenu.pin': 'Épingler à gauche du graphe',
  'workbench.refMenu.pullFastForwardOnly': 'Pull (fast-forward seulement)',
  'workbench.refMenu.pushTo': 'Pousser vers {target}',
  'workbench.refMenu.remoteBranch': 'branche distante',
  'workbench.refMenu.rename': 'Renommer…',
  'workbench.refMenu.renameBranchAria': 'Nouveau nom de branche',
  'workbench.refMenu.renameConfirm': 'Renommer',
  'workbench.refMenu.setUpstream': 'Définir l’upstream…',
  'workbench.refMenu.showAll': 'Tout afficher',
  'workbench.refMenu.solo': 'Solo',
  'workbench.refMenu.soloBranch': 'Isoler {branch}',
  'workbench.refMenu.tag': 'tag',
  'workbench.refMenu.unpin': 'Désépingler du bord gauche',
  'workbench.refMenu.upstream': 'Upstream : {upstream}',

  'workbench.delete.confirm': 'Supprimer',
  'workbench.deleteBoth.consequence':
    'La branche locale et son upstream sont supprimés. Le push de suppression est irréversible pour les autres clones.',
  'workbench.deleteBoth.confirm': 'Supprimer les deux',
  'workbench.deleteBoth.title': 'Supprimer {name} et sa branche distante',
  'workbench.deleteLocal.consequence':
    'La branche locale est supprimée. Ses commits restent joignables par le reflog et les autres branches.',
  'workbench.deleteLocal.title': 'Supprimer la branche {name}',
  'workbench.deleteRemote.consequence':
    'La branche est supprimée sur le remote après un push de suppression. Les autres clones perdent la référence au prochain fetch.',
  'workbench.deleteRemote.confirm': 'Supprimer sur le remote',
  'workbench.deleteRemote.title': 'Supprimer {label}',
  'workbench.stashDrop.consequence':
    'L’entrée de stash {selector} sera supprimée. Le commit {sha} reste récupérable via le reflog Git, sans interface d’undo.',
  'workbench.stashDrop.title': 'Supprimer {selector}',

  'workbench.reset.mode.mixed': 'mixte',
  'workbench.reset.mode.soft': 'douce',

  'workbench.selection.compare': 'Comparer {base} → {target}',
  'workbench.selection.compareCount.one': '{count} commit(s) de A vers B',
  'workbench.selection.compareCount.other': '{count} commit(s) de A vers B',
  'workbench.selection.compareTitle':
    'Comparer {base} et {target} : {count}, affichés à droite du graphe',
  'workbench.selection.count.one': '{count} commit(s) sélectionné(s)',
  'workbench.selection.count.other': '{count} commit(s) sélectionné(s)',
  'workbench.selection.hint':
    'Maj+clic sur un autre commit pour sélectionner la plage, ⌘/Ctrl+clic pour ne comparer que les deux extrémités.',
}

export default messages
