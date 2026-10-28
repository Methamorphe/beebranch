# Architecture Decision Records

Décisions structurantes du projet. Format inspiré de Michael Nygard, adapté au projet.

| ADR | Titre | Statut | Date |
|---|---|---|---|
| [0001](0001-git-cli-single-engine.md) | Git CLI comme moteur unique | accepté | 2026-10-27 |
| [0002](0002-explicit-undo-redo.md) | Annulation explicite, jamais universelle | remplacé par [0008](0008-no-application-backups.md) | 2026-10-27 |
| [0003](0003-benchmark-first-and-canvas.md) | Performance mesurée et rendu canvas virtualisé | accepté | 2026-10-27 |
| [0004](0004-gitlab-rest-v4.md) | GitLab self-hosted via REST v4 et PAT | accepté | 2026-10-27 |
| [0005](0005-per-repo-serialization-and-ipc.md) | Sérialisation par dépôt et IPC borné | accepté | 2026-10-27 |
| [0006](0006-react-frontend.md) | React 19.3 + TypeScript + Vite | accepté | 2026-10-27 |
| [0007](0007-version-baseline.md) | Socle de versions : React stable, Git 2.34+, GitLab maintenu | accepté | 2026-10-27 |
| [0008](0008-no-application-backups.md) | Aucune sauvegarde applicative ; undo limité à Git | accepté | 2026-10-27 |

Décideurs : équipe projet (Tech Lead, reviewers backend et frontend).

Une décision qui change doit être consignée dans un nouvel ADR qui référence celui qu'elle remplace. Ne pas modifier silencieusement un ADR accepté.
| [0009](0009-signed-updates.md) | Mises à jour signées et rollback |
