/**
 * Inventory of the backend error codes and their French default wording.
 *
 * `code` is the stable contract exposed by the Rust backend (`AppError.code`);
 * the message below documents the wording the backend currently sends, so the
 * French interface stays byte-identical to the backend text. `en.ts` mirrors
 * this key set exactly: a code without an English entry breaks the build
 * instead of silently falling back to French.
 *
 * `{name}` placeholders follow the translation runtime convention and stand
 * for the values the backend formats into its message. A few codes carry a
 * single summary line because the backend emits several variants for them
 * (`resource.not_found`, `confirmation.required`, `tls.ca_invalid`,
 * `*.invalid_url`, `*.configuration`).
 */

import type { ErrorCopy } from './types'

const errors = {
  // Generic and IPC.
  'op.cancelled': { message: "L'opération a été annulée." },
  'input.invalid': { message: 'Les données fournies sont invalides.' },
  'resource.not_found': { message: 'La ressource demandée est introuvable.' },
  'app.internal': { message: 'Une erreur interne est survenue.' },
  'ipc.unavailable': { message: 'Le backend est indisponible.' },

  // Git failures classified from the command output (crates/core/src/error.rs).
  'repo.safe_directory': {
    message: "Le dépôt appartient à un autre utilisateur.",
    remediation:
      'Ajoutez explicitement le dépôt à safe.directory si vous lui faites confiance.',
  },
  'repo.busy': {
    message: 'Un autre processus Git utilise ce dépôt.',
    remediation:
      "Vérifiez qu'aucun Git n'est en cours, puis réessayez. Le verrou n'est jamais supprimé automatiquement.",
  },
  'repo.bare': {
    message: 'Cette opération exige un worktree.',
    remediation: 'Ouvrez un worktree associé au dépôt.',
  },
  'repo.not_git': {
    message: "Le dossier n'est pas un dépôt Git.",
    remediation: 'Vérifiez le chemin ou initialisez un dépôt.',
  },
  'auth.host_key': {
    message: "La clé d'hôte SSH n'est pas vérifiée.",
    remediation: 'Vérifiez known_hosts ou connectez-vous une première fois en SSH.',
  },
  'auth.ssh_key': {
    message: 'La clé SSH a été refusée.',
    remediation: 'Vérifiez votre agent SSH et testez `ssh -T git@<hôte>`.',
  },
  'auth.failed': {
    message: "L'authentification Git a échoué.",
    remediation: 'Vérifiez le token ou le credential helper associé.',
  },
  'git.untracked_collision': {
    message: 'Des fichiers non suivis seraient écrasés.',
    remediation:
      'Déplacez ou renommez les fichiers non suivis concernés, puis réessayez.',
  },
  'git.dirty_worktree': {
    message: "Des modifications locales empêchent l'opération.",
    remediation: 'Committez ou stashez les modifications, puis réessayez.',
  },
  'git.unrelated_histories': {
    message: 'Les historiques ne partagent aucun ancêtre.',
    remediation: "Décidez explicitement d'autoriser `--allow-unrelated-histories`.",
  },
  'git.pull_not_fast_forward': {
    message: "Le pull n'a pas pu s'intégrer en avance rapide.",
    remediation:
      "L'historique local a divergé de la branche distante : rebasez ou fusionnez, ou relâchez `pull.ff`.",
  },
  'git.pull_strategy_missing': {
    message: 'Git exige une stratégie pour réconcilier les branches divergentes.',
    remediation:
      'Configurez `pull.rebase` ou `pull.ff`, ou choisissez une stratégie de pull dans BeeBranch.',
  },
  'git.non_fast_forward': {
    message: "Le push n'est pas un fast-forward.",
    remediation: 'Fetchez puis mergez ou rebasez avant de pousser.',
  },
  'git.unresolved_conflicts': {
    message: 'Des conflits ne sont pas résolus.',
    remediation: 'Résolvez les fichiers en conflit, ajoutez-les, puis continuez.',
  },
  'git.conflict': {
    message: "L'opération a produit un conflit.",
    remediation: "Résolvez les conflits, puis continuez ou abandonnez l'opération.",
  },
  'git.identity_missing': {
    message: "L'identité Git est incomplète.",
    remediation: 'Configurez user.name et user.email.',
  },
  'git.signing_failed': {
    message: 'La signature du commit a échoué.',
    remediation: "Vérifiez la clé de signature et l'agent GPG/SSH.",
  },
  'git.remote_missing': {
    message: "Le remote demandé n'existe pas.",
    remediation: 'Vérifiez la configuration des remotes.',
  },
  'git.pathspec': {
    message: 'Le chemin demandé ne correspond à aucun fichier.',
    remediation: "Vérifiez le chemin et son encodage.",
  },
  'git.detached': {
    message: 'HEAD est détaché.',
    remediation: 'Créez une branche avant cette opération.',
  },
  'git.bad_ref': {
    message: 'La référence Git est inconnue.',
    remediation: 'Vérifiez le nom de la branche, du tag ou du SHA.',
  },
  'git.shallow_unsupported': {
    message: 'Le dépôt est shallow et ne permet pas cette opération.',
    remediation: 'Récupérez l\'historique complet (`git fetch --unshallow`).',
  },
  'git.exit_unknown': {
    message: 'La commande Git a échoué (code {code}).',
    remediation: 'Consultez le détail pour la sortie Git complète.',
  },

  // Git process layer (crates/git/src/error.rs).
  'git.program_not_found': {
    message: "Git est introuvable ou n'est pas exécutable.",
    remediation: 'Installez Git 2.34 ou supérieur et vérifiez PATH.',
  },
  'git.unavailable': {
    message: 'Git est introuvable sur cette machine.',
    remediation: "Installez Git puis redémarrez l'application.",
  },
  'git.spawn_failed': {
    message: 'Impossible de lancer le processus Git.',
  },
  'git.invalid_argument': {
    message: 'Argument Git refusé.',
  },
  'git.invalid_environment': {
    message: "Variable d'environnement Git refusée.",
  },
  'git.io': {
    message: "Erreur d'entrée/sortie pendant l'exécution de Git.",
  },
  'git.timeout': {
    message: 'La commande Git a dépassé le délai de {seconds} s.',
    remediation: 'Vérifiez le réseau ou le dépôt, puis réessayez.',
  },
  'git.exit_failure': {
    message: 'La commande Git a échoué (code {code}).',
  },
  'git.version_unsupported': {
    message: 'Version de Git non prise en charge (minimum 2.34).',
    remediation: 'Mettez Git à jour vers la version 2.34 minimum.',
  },
  'git.version_unparsable': {
    message: "La version de Git n'a pas pu être déterminée.",
  },
  'git.internal': {
    message: 'Erreur interne du moteur Git.',
  },

  // Repository, branches, tags, remotes and worktrees.
  'repo.not_open': {
    message: "Le dépôt n'est pas ouvert.",
    remediation: "Ouvrez le dépôt avant de lire son état.",
  },
  'branch.current_delete': {
    message: 'La branche courante ne peut pas être supprimée.',
  },
  'tag.missing': {
    message: 'Le tag est introuvable.',
  },
  'push.remote_ref_missing': {
    message: 'La branche distante est introuvable pour --force-with-lease.',
    remediation: 'Fetchez la branche distante et vérifiez le remote.',
  },
  'workspace.no_remote': {
    message: "Ce dépôt n'a aucun remote.",
  },
  'workspace.detached': {
    message: 'Le pull exige une branche avec upstream.',
  },
  'workspace.no_upstream': {
    message: "La branche n'a pas d'upstream.",
  },
  'worktree.dirty': {
    message: 'Ce worktree contient des modifications non commitées.',
    remediation:
      'Committez ou supprimez les modifications, ou utilisez la suppression forcée après confirmation.',
  },

  // Undo and redo.
  'undo.empty': {
    message: 'Aucune opération annulable.',
  },
  'undo.precondition': {
    message: 'Le dépôt a changé depuis cette opération.',
  },
  'undo.verify_failed': {
    message: "L'état restauré ne correspond pas à l'état attendu.",
  },
  'redo.empty': {
    message: 'Aucune opération à rétablir.',
  },
  'redo.unsupported': {
    message: "Cette opération n'est pas rétablissable.",
  },

  // External tools, patches and updates.
  'tool.missing': {
    message: 'L\'outil {tool} est introuvable.',
    remediation: "Installez l'outil ou indiquez son chemin absolu.",
  },
  'tool.spawn_failed': {
    message: 'Impossible de lancer {program}.',
  },
  'patch.too_large': {
    message: 'Le patch dépasse la limite de 16 Mio.',
  },
  'patch.exists': {
    message: "Le fichier d'export existe déjà ; choisissez un autre nom.",
  },
  'patch.write_failed': {
    message: "Le patch n'a pas pu être exporté.",
  },
  'update.invalid_endpoint': {
    message: "L'endpoint de mise à jour est invalide.",
  },
  'update.rollback_unconfigured': {
    message: "Aucun endpoint de rollback n'est configuré.",
  },
  'update.signature_invalid': {
    message: 'La mise à jour a échoué.',
    remediation:
      'Aucun binaire non signé n\'est installé. Vérifiez le manifeste et la signature de publication.',
  },
  'update.tls': {
    message: 'La mise à jour a échoué.',
    remediation:
      'Aucun binaire non signé n\'est installé. Vérifiez le manifeste et la signature de publication.',
  },
  'update.timeout': {
    message: 'La mise à jour a échoué.',
    remediation:
      'Aucun binaire non signé n\'est installé. Vérifiez le manifeste et la signature de publication.',
  },
  'update.failed': {
    message: 'La mise à jour a échoué.',
    remediation:
      'Aucun binaire non signé n\'est installé. Vérifiez le manifeste et la signature de publication.',
  },
  'update.none': {
    message: "Aucune mise à jour n'est disponible.",
  },
  'update.rollback_unavailable': {
    message: 'Aucune version antérieure signée n\'est disponible.',
  },

  // Local store and keychain.
  'store.database': {
    message: 'erreur SQLite: {error}',
    remediation: "Vérifiez les permissions du dossier de données de l'application.",
  },
  'store.io': {
    message: "erreur d'entrée/sortie: {error}",
    remediation: "Vérifiez les permissions du dossier de données de l'application.",
  },
  'store.keychain': {
    message: 'erreur de keychain: {error}',
    remediation: "Vérifiez les permissions du dossier de données de l'application.",
  },
  'store.invalid': {
    message: 'données invalides: {error}',
    remediation: "Vérifiez les permissions du dossier de données de l'application.",
  },

  // Profiles.
  'profile.no_repo': {
    message: "Aucun dépôt n'est ouvert.",
  },
  'profile.gitlab_unconfigured': {
    message: "Ce profil n'est associé à aucune instance GitLab.",
  },

  // Explicit confirmation of a destructive action.
  'confirmation.required': {
    message: 'Confirmation explicite requise.',
    remediation: "Confirmez explicitement l'action et ses conséquences.",
  },

  // Authentication, network and TLS, shared by Git, GitLab and GitHub.
  'tls.ca_required': {
    message:
      "La connexion TLS à {host} a échoué. Importez le certificat CA de l'instance dans les réglages.",
    remediation: "Importez le certificat PEM de l'autorité interne de l'instance.",
  },
  'tls.ca_invalid': {
    message: 'Le certificat CA importé est invalide.',
    remediation: "Importez le certificat PEM de l'autorité interne de l'instance.",
  },
  'network.unreachable': {
    message: 'Le serveur {host} est injoignable.',
    remediation:
      "Vérifiez l'adresse de l'instance, le proxy et la connexion réseau.",
  },

  // GitLab client and commands.
  'gitlab.not_configured': {
    message: "Aucune instance GitLab n'est configurée.",
    remediation:
      "Renseignez l'URL de l'instance et un Personal Access Token.",
  },
  'gitlab.invalid_url': {
    message: "L'adresse de l'instance GitLab est invalide.",
  },
  'gitlab.insecure_url': {
    message: 'Le schéma http est refusé. Utilisez https pour joindre GitLab.',
  },
  'gitlab.url_credentials': {
    message: "L'adresse GitLab ne doit pas contenir d'identifiants.",
  },
  'gitlab.configuration': {
    message: 'La configuration du client GitLab est invalide.',
  },
  'gitlab.invalid_response': {
    message: 'La réponse de GitLab est illisible.',
  },
  'gitlab.forbidden': {
    message: "Accès refusé par GitLab : le jeton n'a pas les droits nécessaires.",
  },
  'gitlab.not_found': {
    message: 'La ressource GitLab demandée est introuvable.',
  },
  'gitlab.conflict': {
    message: "Conflit avec l'état actuel de la ressource GitLab.",
  },
  'gitlab.validation': {
    message: 'GitLab a refusé la requête : un champ est invalide.',
  },
  'gitlab.rate_limited': {
    message: 'GitLab limite temporairement les requêtes.',
    remediation: 'Patientez avant de relancer la requête.',
  },
  'gitlab.server': {
    message: 'Le serveur GitLab a rencontré une erreur.',
  },
  'gitlab.request_failed': {
    message: 'La requête GitLab a échoué.',
  },
  'gitlab.no_git_credential': {
    message: "Aucun identifiant Git n'est configuré pour {host}.",
    remediation:
      'Authentifiez-vous une fois avec Git pour cet hôte, ou saisissez un Personal Access Token.',
  },
  'gitlab.no_remote': {
    message: 'Aucun remote Git exploitable n\'est configuré.',
    remediation: "Ajoutez un remote SSH ou HTTPS vers l'instance GitLab.",
  },
  'gitlab.project_not_found': {
    message: 'Aucun projet GitLab ne correspond aux remotes du dépôt.',
    remediation:
      "Vérifiez l'URL du remote ou effectuez une association manuelle.",
  },
  'gitlab.project_not_linked': {
    message: "Aucun projet GitLab n'est associé au dépôt.",
  },
  'gitlab.branch_not_pushed': {
    message: "La branche {branch} n'est pas présente sur le remote {remote}.",
    remediation: 'Poussez la branche avant de créer la merge request.',
  },
  'gitlab.discussion_invalid': {
    message: 'GitLab a refusé la discussion (422).',
    remediation:
      'Vérifiez que les SHA de `diff_refs` et la ligne ciblée existent encore dans la merge request.',
  },
  'gitlab.merge_not_allowed': {
    message: "La merge request ne peut pas être fusionnée dans son état actuel.",
    remediation:
      'Vérifiez les checks requis, les conflits, le statut de draft et vos droits sur le projet.',
  },
  'gitlab.merge_conflict': {
    message: 'GitLab signale que la branche ne peut pas être fusionnée (406).',
    remediation: 'Mettez la branche à jour et résolvez les conflits.',
  },
  'gitlab.merge_stale': {
    message: 'La merge request a changé depuis votre lecture (409).',
    remediation: 'Rechargez la merge request puis relancez la fusion.',
  },
  'gitlab.token_missing': {
    message: "Aucun token n'est disponible pour cette instance.",
  },

  // GitHub client and commands.
  'github.not_configured': {
    message: "Aucune instance GitHub n'est configurée.",
    remediation:
      "Renseignez l'URL de l'instance et un Personal Access Token.",
  },
  'github.invalid_url': {
    message: "L'adresse de l'instance GitHub est invalide.",
  },
  'github.insecure_url': {
    message: 'Le schéma http est refusé. Utilisez https pour joindre GitHub.',
  },
  'github.url_credentials': {
    message: "L'adresse GitHub ne doit pas contenir d'identifiants.",
  },
  'github.configuration': {
    message: 'La configuration du client GitHub est invalide.',
  },
  'github.invalid_response': {
    message: 'La réponse de GitHub est illisible.',
  },
  'github.forbidden': {
    message: "Accès refusé par GitHub : le jeton n'a pas les droits nécessaires.",
  },
  'github.not_found': {
    message: 'La ressource GitHub demandée est introuvable.',
  },
  'github.conflict': {
    message: "Conflit avec l'état actuel de la ressource GitHub.",
  },
  'github.validation': {
    message: 'GitHub a refusé la requête : un champ est invalide.',
  },
  'github.rate_limited': {
    message: 'GitHub limite temporairement les requêtes.',
    remediation: 'Patientez avant de relancer la requête.',
  },
  'github.server': {
    message: 'Le serveur GitHub a rencontré une erreur.',
  },
  'github.request_failed': {
    message: 'La requête GitHub a échoué.',
  },
  'github.not_allowed': {
    message: "GitHub refuse cette opération dans l'état actuel de la ressource.",
  },
  'github.no_git_credential': {
    message: "Aucun identifiant Git n'est configuré pour {host}.",
    remediation:
      'Authentifiez-vous une fois avec Git pour cet hôte, ou saisissez un Personal Access Token.',
  },
  'github.no_remote': {
    message: 'Aucun remote Git exploitable n\'est configuré.',
    remediation: 'Ajoutez un remote SSH ou HTTPS vers GitHub.',
  },
  'github.project_not_found': {
    message: "Aucun dépôt GitHub ne correspond aux remotes du dépôt.",
    remediation:
      "Vérifiez l'URL du remote ou effectuez une association manuelle.",
  },
  'github.project_not_linked': {
    message: "Aucun dépôt GitHub n'est associé au dépôt.",
  },
  'github.branch_not_pushed': {
    message: "La branche {branch} n'est pas présente sur le remote {remote}.",
    remediation: 'Poussez la branche avant de créer la pull request.',
  },
  'github.discussion_invalid': {
    message: 'GitHub a refusé le commentaire (422).',
    remediation:
      'Vérifiez que le commit, le chemin et la ligne ciblés existent encore dans la pull request.',
  },
  'github.merge_not_allowed': {
    message: "La pull request ne peut pas être fusionnée dans son état actuel.",
    remediation:
      'Vérifiez les checks requis, les conflits, le statut de brouillon et vos droits sur le dépôt.',
  },
  'github.merge_stale': {
    message: 'La pull request a changé depuis votre lecture (409).',
    remediation: 'Rechargez la pull request puis relancez la fusion.',
  },
  'github.merge_conflict': {
    message: 'GitHub signale que la branche ne peut pas être fusionnée (422).',
    remediation: 'Mettez la branche à jour et résolvez les conflits.',
  },
  'github.unsupported': {
    message: "La résolution d'un thread n'est pas exposée par l'API REST GitHub.",
    remediation: "Résolvez le thread depuis l'interface GitHub.",
  },
  'github.auto_merge_unsupported': {
    message: "GitHub n'expose pas l'auto-merge via l'API REST utilisée.",
    remediation: 'Fusionnez manuellement ou activez l\'auto-merge dans GitHub.',
  },
  'github.remove_branch_unsupported': {
    message:
      'GitHub supprime la branche source selon les réglages du dépôt, pas au moment du merge.',
    remediation:
      'Configurez la suppression automatique dans les réglages du dépôt GitHub.',
  },
  'github.device_flow_unavailable': {
    message: 'La connexion OAuth intégrée ne couvre que github.com.',
  },
  'github.device_flow_missing': {
    message: "Aucune connexion OAuth GitHub n'est en cours.",
  },
  'github.device_flow_expired': {
    message: 'Le code de connexion GitHub a expiré. Relancez la connexion.',
  },
  'github.device_flow_denied': {
    message: 'La connexion GitHub a été refusée.',
  },
  'github.device_flow_disabled': {
    message: "Le device flow n'est pas activé pour cette OAuth App GitHub.",
  },
  'github.oauth_not_configured': {
    message:
      "La connexion OAuth GitHub n'est pas configurée dans cette compilation.",
  },
  'github.oauth_configuration': {
    message: 'La configuration OAuth GitHub est invalide.',
  },
  'blame.binary': { message: 'Le blame n’est pas disponible pour un fichier binaire.' },
  'blame.failed': { message: 'Le blame a échoué.' },
  'blame.too_large': { message: 'Le fichier est trop volumineux pour le blame.' },
  'branch.integration_blocked': { message: 'L’intégration ne peut pas démarrer.', remediation: 'Résolvez la condition signalée puis relancez l’aperçu.' },
  'branch.invalid_name': { message: 'Le nom de branche est invalide.' },
  'branch.not_merged': { message: 'La branche n’est pas mergée dans HEAD.', remediation: 'Utilisez la suppression forcée avec confirmation explicite.' },
  'branch.source_missing': { message: 'La branche source {source} n’existe pas.' },
  'branch.target_missing': { message: 'La branche cible {target} n’existe pas.' },
  'clone.askpass_failed': { message: 'Impossible de préparer l’authentification HTTPS du clone.' },
  'clone.destination_exists': { message: 'La destination existe déjà.', remediation: 'Choisissez un dossier inexistant pour éviter d’écraser des fichiers.' },
  'clone.destination_missing': { message: 'Le clone s’est terminé sans worktree lisible.' },
  'clone.host_key': { message: 'La clé d’hôte SSH du serveur n’est pas vérifiée.', remediation: 'Ajoutez l’empreinte de l’hôte à known_hosts, ou clonez en HTTPS avec la connexion GitLab.' },
  'clone.https_auth': { message: 'L’authentification HTTPS du dépôt a échoué.', remediation: 'Connectez l’instance GitLab pour utiliser son token, ou choisissez SSH avec une clé déclarée.' },
  'clone.not_a_repository': { message: 'Le dossier cloné n’est pas un worktree.' },
  'clone.ssh_auth': { message: 'Le serveur SSH a refusé la clé publique.', remediation: 'Chargez la clé dans l’agent SSH, vérifiez que la clé publique est déclarée dans GitLab, ou utilisez HTTPS.' },
  'commit.empty': { message: 'Aucune modification indexée à committer.', remediation: 'Indexez des fichiers ou autorisez explicitement un commit vide.' },
  'commit.empty_message': { message: 'Le message de commit est vide.', remediation: 'Saisissez un message ou utilisez --allow-empty-message explicitement.' },
  'commit.failed': { message: 'Le commit a échoué.', remediation: 'Corrigez la cause affichée (hook, identité, signature) puis recommencez.' },
  'conflict.markers_remaining': { message: 'La résolution contient encore des marqueurs de conflit.' },
  'conflict.too_large': { message: 'La résolution dépasse la limite de 8 Mio.' },
  'conflict.write_failed': { message: 'La résolution n’a pas pu être écrite.' },
  'discard.stale': { message: 'Le fichier a changé depuis l’affichage du diff.', remediation: 'Rechargez le diff et recommencez le discard.' },
  'discard.untracked': { message: 'Un fichier non suivi n’est jamais supprimé par l’application.', remediation: 'Ajoutez-le au .gitignore ou supprimez-le explicitement dans votre gestionnaire de fichiers.' },
  'git.merge_not_fast_forward': { message: 'L’avance rapide est impossible : la cible possède des commits absents de la source.', remediation: 'Choisissez un commit de fusion, ou rebasez la branche source sur la cible.' },
  'git.operation_failed': { message: 'L’opération Git a échoué.', remediation: 'Lisez la sortie, vérifiez l’état du dépôt, puis réessayez.' },
  'git.revision_missing': { message: 'La révision est introuvable.' },
  'history.failed': { message: 'L’historique du fichier n’a pas pu être lu.' },
  'hooks.unresolved': { message: 'Impossible de résoudre le répertoire des hooks Git.', remediation: 'Vérifiez core.hooksPath et l’état du dépôt.' },
  'ignore.symlink': { message: 'Le .gitignore du dépôt est un lien symbolique.', remediation: 'Modifiez le fichier cible explicitement ; l’application n’écrit pas à travers un lien.' },
  'index.mixed_selection': { message: 'Une requête ne peut pas mélanger fichiers entiers et hunks.', remediation: 'Effectuez les deux actions séparément pour garder un index cohérent.' },
  'index.newline_partial': { message: 'Un hunk sans newline final ne peut pas être stageé partiellement.', remediation: 'Sélectionnez le hunk entier ou le fichier entier.' },
  'index.patch_conflict': { message: 'Le patch ne s’applique plus au contenu actuel.', remediation: 'Rafraîchissez le status puis recommencez ; aucune modification n’a été appliquée.' },
  'index.patch_too_large': { message: 'Le patch dépasse le plafond de sécurité.', remediation: 'Stagez le fichier entier ou par hunks plus petits.' },
  'index.path_not_changed': { message: 'Le chemin sélectionné n’apparaît pas dans le diff.', remediation: 'Stagez le fichier entier pour préserver le renommage.' },
  'index.rename_unsupported': { message: 'Le staging partiel d’un renommage n’est pas supporté.', remediation: 'Stagez le fichier entier pour préserver le renommage.' },
  'init.already_repository': { message: 'Ce dossier contient déjà un dépôt Git.', remediation: 'Ouvrez ce dépôt au lieu de le réinitialiser.' },
  'init.destination_missing': { message: 'La création du dépôt s’est terminée sans dossier lisible.' },
  'init.destination_not_directory': { message: 'La destination existe mais n’est pas un dossier.', remediation: 'Choisissez un autre emplacement.' },
  'init.not_a_repository': { message: 'Le dossier créé n’est pas un dépôt Git.' },
  'init.parent_missing': { message: 'Le dossier parent n’existe pas.', remediation: 'Créez le dossier parent ou choisissez un autre emplacement.' },
  'operation.abort_failed': { message: 'L’opération n’a pas pu être abandonnée.', remediation: 'Inspectez l’état du dépôt avant toute autre action.' },
  'operation.in_progress': { message: 'Une opération Git est déjà en cours.', remediation: 'Terminez-la (continue/abort) avant d’en démarrer une autre.' },
  'operation.none': { message: 'Aucune opération Git n’est en cours.' },
  'operation.skip_unsupported': { message: 'Cette opération ne peut pas être sautée.' },
  'patch.apply_failed': { message: 'Le patch a passé la vérification mais n’a pas pu être appliqué.' },
  'patch.binary_unsupported': { message: 'Les patchs binaires ne sont pas supportés.', remediation: 'Copiez le fichier explicitement ou commitez-le : BeeBranch ne transporte pas de binaire dans un patch.' },
  'patch.conflict': { message: 'Le patch ne s’applique pas sur l’état actuel ; le worktree est inchangé.' },
  'patch.create_failed': { message: 'Le patch n’a pas pu être généré.' },
  'patch.empty': { message: 'Aucune modification ne correspond à cette source.' },
  'rebase.candidates_failed': { message: 'La liste des commits à rebaser n’a pas pu être lue.' },
  'rebase.message_failed': { message: 'Le message du commit n’a pas pu être lu.' },
  'rebase.nothing_to_do': { message: 'Aucun commit ne peut être rebasé sur cette base.' },
  'rebase.plan_invalid': { message: 'Plan de rebase invalide ({what}) : {reason}.' },
  'remote.add_failed': { message: 'Le remote n’a pas pu être ajouté.' },
  'remote.prune_failed': { message: 'Le prune du remote a échoué.' },
  'remote.remove_failed': { message: 'Le remote n’a pas pu être supprimé.' },
  'remote.set_url_failed': { message: 'L’URL du remote n’a pas pu être modifiée.' },
  'remote.url_has_credentials': { message: 'L’URL du remote ne doit pas contenir de mot de passe.', remediation: 'Utilisez un credential helper ou une clé SSH ; aucun secret n’est stocké dans l’URL.' },
  'repo.closed': { message: 'La session de dépôt est fermée.' },
  'search.content_failed': { message: 'La recherche de contenu a échoué.' },
  'stash.apply_failed': { message: 'Le stash n’a pas pu être appliqué.', remediation: 'Résolvez l’état du dépôt puis réessayez.' },
  'submodule.url_has_credentials': { message: 'L’URL du sous-module ne doit pas contenir de mot de passe.' },
  'tag.create_failed': { message: 'Le tag n’a pas pu être créé.' },
  'tag.delete_failed': { message: 'Le tag n’a pas pu être supprimé.' },
  'tag.identity_missing': { message: 'Aucune identité Git n’est configurée pour signer le tag.' },
  'tag.push_failed': { message: 'Le push du tag a échoué.' },
  'undo.file_unreadable': { message: 'Un fichier affecté n’a pas pu être lu.' },
  'undo.index_unmerged': { message: 'L’index contient des conflits non résolus.' },
  'undo.locked': { message: 'Un verrou Git empêche l’annulation.', remediation: 'Attendez la fin du processus Git, puis réessayez.' },
  'undo.operation_in_progress': { message: 'Une opération Git est en cours.', remediation: 'Terminez ou abandonnez explicitement l’opération avant d’annuler.' },
  'undo.remote_missing': { message: 'Le remote est introuvable.' },
  'undo.stash_not_exact': { message: 'Le stash appliqué ne correspond pas exactement à l’état attendu ; il n’a pas été supprimé.' },
  'undo.unsupported': { message: 'L’abandon d’un bisect n’est pas annulable.' },
  'worktree.missing': { message: 'Le worktree n’est plus présent sur le disque.' },
  'worktree.path_exists': { message: 'Le chemin du nouveau worktree existe déjà.' },
  'worktree.unknown': { message: 'Ce worktree n’appartient pas à ce dépôt.' },
} satisfies Record<string, ErrorCopy>

export default errors
