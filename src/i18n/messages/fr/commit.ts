const messages = {
  // Commit panel
  'commit.panel.title': 'Nouveau commit',
  'commit.panel.placeholder': 'Résumé du commit\n\nDescription (facultative)',
  'commit.panel.messageAria': 'Message de commit',
  'commit.panel.template': 'Résumé court\n\nCorps du message (optionnel).\n',
  'commit.panel.useTemplate': 'Utiliser un modèle',
  'commit.panel.options': 'Options du commit',
  'commit.panel.optionsAmend': 'amend actif',
  'commit.panel.optionsEmpty': 'commit vide autorisé',
  'commit.panel.amend': 'Amend',
  'commit.panel.keepMessage': 'Conserver le message',
  'commit.panel.allowEmpty': 'Autoriser un commit vide',
  'commit.panel.skipHooks': 'Ignorer les hooks',
  'commit.panel.skipHooksHint':
    'Désactive tous les hooks pour ce commit uniquement ; le choix n’est pas mémorisé.',
  'commit.panel.identity': 'Identité et signature',
  'commit.panel.signature': 'Signature : {state}',
  'commit.panel.signatureEnabled': 'activée par Git',
  'commit.panel.signatureDisabled': 'non configurée',
  'commit.panel.signatureKey': 'clé {key}',
  'commit.panel.signatureFormat': 'format {format}',
  'commit.panel.loadingConfig': 'Lecture de la configuration…',
  'commit.panel.hooksNotice':
    'Les hooks et la signature configurés dans Git sont respectés.',
  'commit.panel.hooksRunning': 'Hooks Git — en cours',
  'commit.panel.hooksOutput': 'Sortie des hooks Git',
  'commit.panel.submitTitle': 'Créer le commit · ⌘/Ctrl + Entrée',
  'commit.panel.creating': 'Création…',
  'commit.panel.amendCommit': 'Amender le commit',
  'commit.panel.createEmpty': 'Créer un commit vide',
  'commit.panel.createWithFiles.one': 'Créer le commit · {count} fichier(s)',
  'commit.panel.createWithFiles.other': 'Créer le commit · {count} fichier(s)',
  'commit.panel.needFiles': 'Préparez des fichiers pour committer',
  'commit.panel.enterKey': 'Entrée',
  'commit.panel.toCommit': 'pour committer',
  'commit.panel.conflictsHint': 'Résolvez les conflits avant de committer.',
  'commit.panel.created': 'créé',
  'commit.panel.signed': '(signé)',
  'commit.panel.copySha': 'Copier le SHA',
  'commit.panel.shaCopied': 'SHA copié',
  'commit.panel.undoCommit': 'Annuler le commit',
  'commit.panel.undoing': 'Annulation…',

  // Amend dialog
  'commit.amend.title': 'Amender {target}',
  'commit.amend.rewritesHistory': 'Amender réécrit l’historique :',
  'commit.amend.replaced': 'est remplacé par un nouveau commit.',
  'commit.amend.branchHint':
    'La branche {branch} pointera vers le nouveau commit. S’il est déjà poussé, un push --force-with-lease sera nécessaire et les autres clones devront se resynchroniser.',
  'commit.amend.detachedHint':
    'HEAD est détachée : le commit amendé ne sera référencé par aucune branche tant que vous n’en créez pas une.',
  'commit.amend.loading': 'Lecture du commit…',
  'commit.amend.truncatedNotice':
    'Le message dépasse la limite de lecture et n’est pas modifiable ici ; seules les modifications préparées seront amendées.',
  'commit.amend.messageLabel': 'Message du commit',
  'commit.amend.messageAria': 'Message du commit à amender',
  'commit.amend.staged.one': '{count} fichier préparé sera inclus dans le commit amendé.',
  'commit.amend.staged.other': '{count} fichiers préparés seront inclus dans le commit amendé.',
  'commit.amend.noStaged':
    'Aucune modification préparée : seul le message sera modifié. Préparez des fichiers dans l’onglet Statut pour les inclure.',
  'commit.amend.noChanges':
    'Modifiez le message ou préparez des fichiers pour pouvoir amender.',
  'commit.amend.headMoved':
    'HEAD a changé depuis l’ouverture : Git n’amenderait plus le commit affiché. Fermez cette boîte de dialogue et relancez l’amendement.',
  'commit.amend.amending': 'Amendement…',
  'commit.amend.submit': 'Amender le commit',

  // Tag dialog
  'commit.tag.title': 'Créer un tag',
  'commit.tag.titleAnnotated': 'Créer un tag annoté',
  'commit.tag.pointsTo': 'Le tag pointe sur',
  'commit.tag.pushHint':
    'Le push d’un tag reste une action explicite depuis l’onglet Tags.',
  'commit.tag.nameAria': 'Nom du tag',
  'commit.tag.namePlaceholder': 'v1.0.0',
  'commit.tag.namePlaceholderRc': 'v1.0.0-rc1',
  'commit.tag.messageAria': 'Message du tag annoté',
  'commit.tag.messagePlaceholder': 'chore(release): prépare la version',
  'commit.tag.creating': 'Création…',
  'commit.tag.submit': 'Créer le tag',

  // Worktree dialog
  'commit.worktree.title': 'Créer un worktree',
  'commit.worktree.description': 'Une seconde copie de travail sur',
  'commit.worktree.shared':
    'Le dépôt reste partagé : une branche ne peut être extraite que dans un seul worktree à la fois.',
  'commit.worktree.destinationLabel': 'Dossier de destination',
  'commit.worktree.pathPlaceholder': '/Users/you/src/project-feature',
  'commit.worktree.pathAria': 'Dossier du worktree',
  'commit.worktree.choose': 'Choisir…',
  'commit.worktree.newBranchLabel': 'Nouvelle branche (optionnel)',
  'commit.worktree.branchPlaceholder': 'feature/nouvelle',
  'commit.worktree.branchAria': 'Nouvelle branche du worktree',
  'commit.worktree.detach': 'HEAD détachée',
  'commit.worktree.creating': 'Création…',
  'commit.worktree.submit': 'Créer le worktree',

  // Stash panel
  'commit.stash.title': 'Créer un stash',
  'commit.stash.messageLabel': 'Message du stash (optionnel)',
  'commit.stash.messagePlaceholder': 'Message du stash',
  'commit.stash.messageAria': 'Message du stash',
  'commit.stash.includeUntracked': 'Inclure les fichiers non suivis',
  'commit.stash.create': 'Créer le stash',
  'commit.stash.notice':
    'Les fichiers non suivis ne sont jamais inclus implicitement. Un pop en conflit laisse le stash intact.',
  'commit.stash.conflictsNotice':
    'Stash appliqué avec {count} conflit(s) ({files}) ; le stash est conservé jusqu’à résolution.',
  'commit.stash.listTitle': 'Stashes ({count})',
  'commit.stash.emptyTitle': 'Aucun stash enregistré',
  'commit.stash.emptyHint':
    'Mettez vos modifications de côté pour les reprendre plus tard.',
  'commit.stash.applyAndDrop': 'Appliquer et retirer',
  'commit.stash.delete': 'Supprimer…',
  'commit.stash.createdNotice': 'Stash créé.',
  'commit.stash.appliedNotice': 'Stash {selector} appliqué.',
  'commit.stash.poppedNotice': 'Stash {selector} poppé.',
  'commit.stash.droppedNotice': 'Stash supprimé · SHA {sha}',
  'commit.stash.deleteTitle': 'Supprimer {selector}',
  'commit.stash.deleteConsequence':
    "L'entrée de stash {selector} sera supprimée. Le commit {sha} reste récupérable via le reflog Git, sans interface d'undo.",
}

export default messages
