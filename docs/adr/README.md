# Architecture Decision Records

Structuring decisions for the project. Format inspired by Michael Nygard, adapted to the project.

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-git-cli-single-engine.md) | Git CLI as the single engine | accepted | 2026-10-27 |
| [0002](0002-explicit-undo-redo.md) | Explicit undo, never universal | superseded by [0008](0008-no-application-backups.md) | 2026-10-27 |
| [0003](0003-benchmark-first-and-canvas.md) | Measured performance and virtualized canvas rendering | accepted | 2026-10-27 |
| [0004](0004-gitlab-rest-v4.md) | Self-hosted GitLab via REST v4 and PAT | accepted | 2026-10-27 |
| [0005](0005-per-repo-serialization-and-ipc.md) | Per-repository serialization and bounded IPC | accepted | 2026-10-27 |
| [0006](0006-react-frontend.md) | React 19.3 + TypeScript + Vite | accepted | 2026-10-27 |
| [0007](0007-version-baseline.md) | Version baseline: stable React, Git 2.34+, maintained GitLab | accepted | 2026-10-27 |
| [0008](0008-no-application-backups.md) | No application backups; undo limited to Git | accepted | 2026-10-27 |

Deciders: project team (Tech Lead, backend and frontend reviewers).

A decision that changes must be recorded in a new ADR that references the one it replaces. Do not silently modify an accepted ADR.
| [0009](0009-signed-updates.md) | Signed updates and rollback |
