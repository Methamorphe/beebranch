# 09 — Risques, prototypes et décisions

## 1. Registre des risques

| ID | Risque | Probabilité | Impact | Mitigation | Signal d'alerte |
|---|---|---|---|---|---|
| R-01 | Le graphe n'atteint pas la fluidité attendue | Moyenne | Très élevé | Prototype P0 canvas + mesure ; aucune optimisation tardive | p95 frame > budget sur corpus 100k |
| R-02 | Le parsing CLI est fragile | Moyenne | Élevé | Formats machine, fixtures, tests de contrat, erreurs typées | un parseur casse sur un dépôt réel |
| R-03 | Le staging ligne/hunk corrompt l'index | Moyenne | Très élevé | Patch engine testé (CRLF, no-newline, renommages), vérification avant/après | `git diff` incohérent après staging |
| R-04 | Merge/rebase/conflits produisent des états incorrects | Moyenne | Très élevé | Délégation à Git, préflight, abort/continue testés, fault injection | état intermédiaire non détecté |
| R-05 | Variantes GitLab self-hosted | Élevée | Moyen | Feature detection, tests sur les 3 dernières versions maintenues, endpoints actuels | 404/403 inattendus en production |
| R-06 | TLS/proxy d'entreprise | Moyenne | Élevé | CA importable, proxy explicite, messages actionnables | utilisateurs bloqués à la connexion |
| R-07 | Dérive du périmètre | Élevée | Élevé | P0–P3 fermés, fiches de tâches, revue de scope | fonctionnalité hors fiche dans une PR |
| R-08 | Divergences de webview Tauri | Moyenne | Moyen | Tests 3 OS, rendu canvas, pas d'API exotique | bug visuel/perf sur un seul OS |
| R-09 | Undo cause une perte de données | Faible | Très élevé | Matrice, préconditions, refus par défaut, actions irréversibles explicites | restauration partielle non signalée |
| R-10 | Configuration de dépôt exécutable | Moyenne | Moyen | Avertissement à l'ouverture, transparence, pas d'exécution implicite | filtre/hook inattendu |
| R-11 | Annulation de processus peu fiable | Moyenne | Moyen | Tests par OS, arrêt gracieux puis forcé, revalidation | processus orphelin |
| R-12 | Budgets inatteignables avec CLI | Moyenne | Élevé | Baseline P0, décision documentée, `gix` ciblé si preuve | scénario > budget après optimisations |
| R-13 | Mémoire excessive sur gros dépôts | Moyenne | Moyen | Caches bornés, pages, libération à la fermeture | RSS > budget sur 100k |
| R-14 | Maintenance long terme | Moyenne | Moyen | Peu d'abstractions, docs, tests, ADR | complexité croissante sans besoin |
| R-15 | Fuite de token | Faible | Très élevé | Keychain, redaction, tests d'artefacts | token dans un log/export |
| R-16 | Perte de travail sur action destructive (aucune sauvegarde) | Moyenne | Élevé | Confirmation forte, irréversibilité affichée, aucun fichier non suivi supprimé | utilisateur surpris par un discard ou un reset --hard |

## 2. Prototypes obligatoires (P0)

Chaque prototype répond à une question et produit une preuve. Il n'est pas un produit : il peut être jeté.

### SP-01 — Rendu du graphe

- **Question :** canvas + virtualisation + lanes Rust tiennent-ils le scroll sur 100k–1M commits avec branches/merges ?
- **Méthode :** corpus `linear-100k`, `merges-deep`, `branches-5k` ; scroll programmatique ; mesure frame p50/p95, frames > 50 ms, RSS.
- **Critère de sortie :** budget provisoire tenu ou cause identifiée ; algorithme de lanes validé sur merges/octopus.
- **Fallback :** réduire les fonctionnalités visuelles, revoir la stratégie de rendu, ou réviser le budget avec preuve.

### SP-02 — Lectures CLI

- **Question :** `status`, première page de log, diff et refs sont-ils assez rapides via CLI ?
- **Méthode :** mesure isolée de chaque commande et du parsing sur corpus ; comparaison avec le budget.
- **Critère de sortie :** tableau de mesures par scénario ; décision explicite : conserver CLI, optimiser, ou introduire `gix` sur un chemin précis.
- **Fallback :** `gix` ciblé pour une lecture, avec ADR et tests de non-régression.

### SP-03 — Staging partiel

- **Question :** peut-on générer et appliquer des patchs de ligne/hunk de façon fiable ?
- **Méthode :** fixtures CRLF, absence de newline, renommage, mode exécutable, Unicode, contexte ambigu, patch vide ; vérification de l'index avant/après.
- **Critère de sortie :** 100 % des fixtures passent, aucun cas partiel silencieux.
- **Fallback :** limiter au staging par fichier/hunk en P1 et reporter la ligne, avec décision explicite.

### SP-04 — Rebase interactif

- **Question :** l'injection de todo via helper est-elle fiable sur les trois OS ?
- **Méthode :** plan pick/reword/squash/drop, conflits, abort, reprise après crash.
- **Critère de sortie :** todo correct, reword/squash fonctionnels, conflits gérables, aucun todo corrompu.
- **Fallback :** rebase non interactif + édition de message séparée, en attendant.

### SP-05 — GitLab self-hosted

- **Question :** l'intégration fonctionne-t-elle avec préfixe d'URL, CA interne, token, versions maintenues et paliers ?
- **Méthode :** instance de test en conteneur, trois versions maintenues, certificat auto-signé, endpoints liste/détail/diffs/création/pipelines.
- **Critère de sortie :** parcours complet vert, erreurs 401/403/404/429 correctement mappées, feature detection validée.
- **Fallback :** réduire le périmètre MVP (liste + ouverture navigateur) et planifier le reste.

### SP-06 — IPC et streaming

- **Question :** les pages et événements restent-ils sous les limites sans dégrader l'UI ?
- **Méthode :** page de 500/1000, diff 50k lignes, fetch avec progression.
- **Critère de sortie :** payload < 1 Mio, pas de blocage du thread UI, annulation fonctionnelle.
- **Fallback :** adapter la taille de page, introduire un format binaire si mesuré nécessaire.

### SP-07 — Crash et reprise

- **Question :** un kill pendant fetch/commit/rebase laisse-t-il un état compréhensible et récupérable ?
- **Méthode :** kill -9 / TerminateProcess à des points contrôlés ; redémarrage ; vérification de l'état et des verrous.
- **Critère de sortie :** aucun fichier perdu, état intermédiaire détecté, aucune suppression automatique de verrou.
- **Fallback :** renforcer le journal, ajouter un panneau de récupération manuel.

## 3. Ce qui n'est pas un risque acceptable

- Supprimer un `index.lock` automatiquement.
- Désactiver TLS pour « faire marcher ».
- Mettre un token dans une URL ou un log.
- Utiliser `reset --hard` comme mécanisme générique.
- Charger tout l'historique au démarrage.
- Exécuter une commande via un shell.
- Marquer une fonctionnalité terminée sans test réel.
- Ajouter une abstraction « pour plus tard ».

## 4. Décisions

### 4.1 Décisions tranchées

| ID | Décision | Valeur | Date | Référence |
|---|---|---|---|---|
| D-01 | Framework frontend | **React 19.3 + TypeScript + Vite** | 2026-10-27 | [ADR-0006](adr/0006-react-frontend.md) |
| D-02 | Nom du produit | **BeeBranch** | 2026-10-27 | README |
| D-03 | Version minimale de Git | **2.34** (plancher LTS distro), tests sur 2.56.0 | 2026-10-27 | [ADR-0007](adr/0007-version-baseline.md) |
| D-04 | Versions GitLab | **3 dernières maintenues** (19.3–19.5), pas de LTS | 2026-10-27 | [ADR-0007](adr/0007-version-baseline.md) |
| D-05 | Sauvegardes d'undo | **Aucune sauvegarde applicative** | 2026-10-27 | [ADR-0008](adr/0008-no-application-backups.md) |
| D-13 | Identité visuelle | **Palette Beecoming, accent `#FED100`, ergonomie inspirée de GitKraken** | 2026-10-27 | [10-design-direction](10-design-direction.md) |

### 4.2 Décisions ouvertes

| ID | Décision | Options | Recommandation | Impact |
|---|---|---|---|---|
| D-06 | Dépôts bare / shallow / partial | supporter / refuser / lecture seule | lecture seule pour shallow, refus bare | Périmètre |
| D-07 | Mise à jour | intégrée / package manager | intégrée signée | Distribution |
| D-08 | Niveau d'accessibilité | de base / WCAG 2.2 AA | AA sur les vues principales | Design, tests |
| D-09 | Chiffrement du cache local | non / OS / app | non au MVP, documenté | Complexité |
| D-10 | Diff MR local vs API | API / ref local | API au MVP, ref local ensuite | Exactitude, perf |
| D-11 | HTTP non TLS | interdire / autoriser avec avertissement | interdire | Sécurité |
| D-12 | Télémétrie | aucune / opt-in locale | aucune | Confiance |

Chaque décision prise doit être consignée dans un ADR ou dans ce tableau avec sa date.
