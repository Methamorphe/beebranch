# Sécurité

## Versions supportées

Les correctifs de sécurité sont publiés sur la dernière version stable
(`vX.Y.Z` de [la dernière release](https://github.com/Methamorphe/beebranch/releases/latest)).
Les versions antérieures ne reçoivent pas de correctif ; la mise à jour est
signée et le rollback est disponible dans l'application.

## Signaler une vulnérabilité

N'ouvrez **pas** d'issue publique pour une vulnérabilité. Utilisez le
signalement privé de GitHub :

<https://github.com/Methamorphe/beebranch/security/advisories/new>

Indiquez : version affectée, plateforme, reproduction minimale, impact observé,
et toute preuve (sortie, capture, journal redacté). Ne joignez jamais de token,
de clé privée ou de donnée personnelle réelle.

Accusé de réception sous 72 heures ouvrées. Une correction est publiée avec une
release signée ; le crédit est ajouté à l'avis sauf demande contraire.

## Modèle de menace

| Actif | Mesure |
|---|---|
| Tokens GitLab/GitHub | Stockés dans le keychain de l'OS (`crates/store`), jamais dans SQLite, le frontend, les logs ou les diagnostics. Les sorties Git et HTTP sont redactées (`crates/core/src/redaction.rs`). |
| Mises à jour | Artefacts minisign vérifiés par `tauri-plugin-updater` **avant** installation ; clé publique embarquée dans `tauri.conf.json` ; endpoint servi par HTTPS. Un dépôt ou un CDN compromis ne suffit pas à installer un binaire arbitraire. |
| Transport | TLS vérifié pour GitLab, GitHub et le manifeste de mise à jour ; endpoint non HTTPS refusé hors loopback. |
| Commandes Git | La CLI `git` est invoquée sans shell, avec des arguments séparés (`crates/git`), pour éviter l'injection de commandes et d'arguments. |
| Frontend | Aucun secret ni accès réseau direct : le WebView parle uniquement via les commandes Tauri typées (IPC), sous CSP restrictive. |
| Données | Local-first : aucun envoi de télémétrie, d'analytics ou de contenu de dépôt. L'audit `npm run audit:telemetry` échoue si une référence d'analytics apparaît dans les sources. |

## Hors périmètre

- Un dépôt local ou un remote déjà compromis par l'utilisateur.
- L'exécution de hooks Git, de merge tools ou d'éditeurs configurés par
  l'utilisateur, qui s'exécutent avec ses droits par conception.
- Les vulnérabilités des dépendances déjà corrigées en amont et signalées par
  Dependabot sans impact sur BeeBranch.
- Le binaire signé par les mainteneurs mais récupéré depuis une source non
  officielle.

## Divulgation

Les avis sont publiés via GitHub Security Advisories, avec la release corrective
et, le cas échéant, une note dans [CHANGELOG.md](CHANGELOG.md).
