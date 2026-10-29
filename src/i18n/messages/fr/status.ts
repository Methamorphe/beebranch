const messages = {
  'status.entry.untracked': 'non suivi',
  'status.entry.unmerged': 'conflit',
  'status.entry.renamed': 'renommé',
  'status.entry.copied': 'copié',
  'status.entry.ignored': 'ignoré',

  'status.group.conflicts': 'Conflits à résoudre',
  'status.group.worktree': 'À préparer',
  'status.group.index': 'Prêts à committer',
  'status.group.ignored': 'Ignorés',
  'status.group.unstageAll': 'Fichiers retirés de l’index.',
  'status.group.stageAll': 'Fichiers ajoutés à l’index.',
  'status.group.unstageAllAction': 'Tout retirer',
  'status.group.stageAllAction': 'Tout préparer',
  'status.group.emptyStaged': 'Préparez les fichiers à inclure dans le commit.',
  'status.group.emptyUnstaged': 'Aucun fichier à préparer.',

  'status.notice.staged': 'Indexé : {path}',
  'status.notice.unstaged': 'Retiré de l’index : {path}',
  'status.notice.discardOne': 'Discard irréversible : {path}',
  'status.notice.discardMany': 'Discard irréversible : {count} fichiers',
  'status.notice.ignored': 'Ajouté au .gitignore : {pattern}',
  'status.notice.mergeTool': 'Merge tool ouvert : {path}',
  'status.notice.editor': 'Éditeur ouvert : {path}',
  'status.notice.resolved': 'Conflit marqué résolu : {path}',

  'status.error.discardUnsupported':
    'Un fichier non suivi ou en conflit ne peut pas être discardé ici.',
  'status.loading': 'Lecture du status…',
  'status.empty': 'Aucun status.',

  'status.bulk.staged.one': '{count} fichier(s) préparé(s).',
  'status.bulk.staged.other': '{count} fichier(s) préparé(s).',
  'status.bulk.unstaged.one': '{count} fichier(s) retiré(s) de l’index.',
  'status.bulk.unstaged.other': '{count} fichier(s) retiré(s) de l’index.',
  'status.bulk.selected.one': '{count} sélectionné',
  'status.bulk.selected.other': '{count} sélectionnés',
  'status.bulk.regionAria': 'Fichiers sélectionnés',
  'status.bulk.stage': 'Préparer',
  'status.bulk.unstage': 'Retirer',
  'status.bulk.discard': 'Abandonner…',
  'status.bulk.discardTitle': 'Sélectionnez uniquement des fichiers modifiés non préparés.',

  'status.row.select': 'Sélectionner {path}',
  'status.row.selectRange': 'Sélectionner {path} · Maj+clic pour une plage',
  'status.row.resolve': 'Résoudre',
  'status.row.unstageTitle': 'Retirer de l’index',
  'status.row.stageTitle': 'Préparer ce fichier',
  'status.row.unstageAria': 'Retirer {path}',
  'status.row.stageAria': 'Préparer {path}',
  'status.row.actionsAria': 'Actions pour {path}',
  'status.row.openEditor': 'Ouvrir dans l’éditeur',
  'status.row.mergeTool': 'Outil de fusion',
  'status.row.markResolved': 'Marquer résolu',
  'status.row.ignoreFile': 'Ignorer le fichier',
  'status.row.ignorePattern': 'Ignorer {pattern}',
  'status.row.ignoreDir': 'Ignorer le dossier',
  'status.row.discardAction': 'Abandonner les modifications…',

  'status.filter.placeholder': 'Filtrer les fichiers…',
  'status.filter.aria': 'Filtrer les chemins',
  'status.filter.none': 'Aucun fichier ne correspond à « {filter} ».',

  'status.view.options': 'Options d’affichage des fichiers',
  'status.view.tree': 'Afficher en arborescence',
  'status.view.treeTitle': 'Regrouper les fichiers par dossier, avec des dossiers repliables',
  'status.view.ignored': 'Afficher les fichiers ignorés',
  'status.view.ignoredTitle': 'Afficher les fichiers ignorés',

  'status.locks': 'Verrous Git : {list}',
  'status.truncated': 'Liste partielle. Filtrez pour affiner les résultats.',
  'status.more': '{count} autres fichiers. Affinez le filtre.',

  'status.clean.title': 'Tout est à jour',
  'status.clean.body': 'Aucune modification locale. Votre prochain commit commence ici.',

  'status.discard.title': 'Discard irréversible',
  'status.discard.consequenceOne':
    '1 fichier ({path}) : le contenu non indexé sera remplacé par la version de l’index.',
  'status.discard.consequenceMany':
    '{count} fichiers ({list}) : le contenu non indexé sera remplacé par la version de l’index.',
  'status.discard.confirm': 'Discard',
}

export default messages
