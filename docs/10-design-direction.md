# 10 — Direction visuelle

## 1. Intention

BeeBranch doit être **immédiatement familier** à un utilisateur de GitKraken : mêmes repères visuels, même densité, même lecture de l'historique. Il doit aussi avoir **sa propre identité** : nom, logo, palette et iconographie originales.

La référence est l'**ergonomie**, pas les assets.

## 2. Ce qui est repris de l'expérience GitKraken

- Graphe d'historique central, lanes colorées, refs visibles, merges lisibles.
- Panneau gauche de références (branches, remotes, tags, stashes, worktrees).
- Panneau droit de détail (commit, fichiers, diff, métadonnées).
- Onglets de dépôts et navigation rapide.
- Barre d'état discrète : branche courante, ahead/behind, état de synchronisation.
- Densité élevée : lignes compactes, peu d'espace perdu.
- Actions contextuelles au clic droit.
- Command palette et raccourcis clavier.
- Thème sombre par défaut, thème clair disponible.

## 3. Identité propre

| Élément | Direction |
|---|---|
| Nom | **BeeBranch** |
| Symbole | Abeille / rayon / branche, à faire dessiner ; jamais le logo GitKraken |
| Accent | **Jaune Beecoming `#FED100`**, décliné en `#F5BB45` sur fond sombre dans la maquette de référence ; réservé aux actions primaires, à la sélection et au focus |
| Base | Fond `#101216`, panneaux `#15181E`, surfaces élevées `#1C2028`, bordures `#282D36`, texte `#E1E5EC`, secondaire `#8992A2` (maquette de référence) |
| Palette de lanes | 6 couleurs fonctionnelles dérivées, lisibles sur fond noir ; le jaune d'accent n'est pas utilisé comme lane |
| Iconographie | Jeu d'icônes original ou bibliothèque sous licence compatible |
| Typographie | **Geist** pour l'UI, **Geist Mono** pour les diffs et SHA, embarquées via Fontsource (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`) |
| Ton | Technique, calme, précis ; pas de marketing dans l'application |

La palette de base est relevée sur le site Beecoming : `#0A0A0A`, `#191919`, `#F6F6F6`, `#EDEDED`, `#FED100`. La maquette de référence P2 (`/Users/johannbee/Downloads/beebranch/index.html`) fixe les valeurs implémentées : `#101216`, `#15181E`, `#1C2028`, `#282D36`, `#E1E5EC`, `#8992A2`, accent `#F5BB45`. Les valeurs d'état et de lanes sont dérivées pour l'application.

**Garde-fous juridiques et éthiques**

- Ne pas copier les assets, icônes, captures, polices, logos ou la palette exacte de GitKraken.
- Ne pas utiliser « GitKraken » dans le nom, le logo, le domaine ou la communication produit.
- Ne pas reproduire le trade dress de façon identifiable ; s'inspirer de conventions d'interface courantes (graphe, panneaux, onglets) est acceptable.
- Vérifier la licence de toute icône ou police tierce avant intégration.

## 4. Structure de l'écran principal

```text
┌─────────────────────────────────────────────────────────────┐
│ Barre supérieure : dépôt, branche, fetch/pull/push, recherche │
├──────────────┬──────────────────────────────┬───────────────┤
│ Références   │ Graphe + liste des commits   │ Détail commit │
│ branches     │ lanes, refs, auteurs, dates  │ fichiers      │
│ remotes      │                              │ diff          │
│ tags         │                              │ métadonnées   │
│ stashes      │                              │               │
│ worktrees    │                              │               │
├──────────────┴──────────────────────────────┴───────────────┤
│ Barre d'état : état Git, sync, index, opérations             │
└─────────────────────────────────────────────────────────────┘
```

- Trois colonnes redimensionnables, mémorisées par dépôt.
- Le graphe reste la zone dominante.
- Les panneaux peuvent être masqués, jamais au détriment de l'état Git visible.
- Les actions destructives ou les états intermédiaires occupent une zone persistante, pas un toast éphémère.

Sous `1120px`, le détail du commit, la comparaison et la préparation du commit
deviennent un **drawer superposé** au graphe au lieu d'être empilés : le graphe
conserve sa hauteur, le panneau se ferme par son bouton ou `Échap`. La barre
d'état reste actionnable (branche, compteurs, opérations, GitLab) et son menu
Opérations expose le journal récent sans transformer les retours en toasts.

## 5. Tokens

| Token | Sombre | Clair | Usage |
|---|---|---|---|
| `--bg` | `#0A0A0A` | `#F6F6F6` | fond principal |
| `--surface` | `#191919` | `#FFFFFF` | panneaux |
| `--surface-raised` | `#242424` | `#FFFFFF` | dialogues, menus |
| `--border` | `#2E2E2E` | `#E6E6E6` | séparateurs |
| `--text` | `#EDEDED` | `#191919` | texte principal |
| `--muted` | `#A3A3A3` | `#616161` | métadonnées |
| `--accent` | `#FED100` | `#FED100` | actions primaires, sélection |
| `--accent-contrast` | `#191919` | `#191919` | texte sur accent |
| `--accent-soft` | `#FED10026` | `#FED10033` | fond de sélection |
| `--success` | `#07BC0C` | `#078A0B` | succès CI |
| `--warning` | `#F97316` | `#C2410C` | avertissement |
| `--error` | `#E74D3C` | `#C0392B` | erreur |
| `--lane-1` | `#4EA8DE` | `#2B7CB3` | bleu |
| `--lane-2` | `#9B5DE5` | `#7B3FC4` | violet |
| `--lane-3` | `#00A6A6` | `#007A7A` | teal |
| `--lane-4` | `#E85D9E` | `#C23A78` | rose |
| `--lane-5` | `#F97316` | `#C2410C` | orange |
| `--lane-6` | `#7CB518` | `#557D0F` | vert |

- `#FED100` est la couleur d'accent officielle de Beecoming et ne doit pas être utilisée comme couleur de lane.
- Les valeurs sombres respectent le fond `#0A0A0A` / `#191919`.
- Les valeurs claires sont des variantes assombries pour préserver le contraste.
- Sur fond clair, `#FED100` ne porte jamais de texte clair : utiliser `--accent-contrast` (`#191919`).
- Contrastes vérifiés : `#EDEDED`/`#191919` = 15,0:1 ; `#191919`/`#FED100` = 12,0:1 ; `#A3A3A3`/`#191919` = 7,0:1. Les lanes sont validées au minimum graphique 3:1.

## 6. Densité et mouvement

- Mode compact par défaut : lignes de 28–32 px, pas de padding décoratif.
- Mode confortable disponible.
- Animations courtes (120–160 ms), jamais bloquantes, désactivées avec `prefers-reduced-motion`.
- Pas d'animation sur le scroll du graphe.
- Les transitions servent la compréhension (ouverture de panneau, changement d'onglet), pas la décoration.

## 7. Accessibilité

- Contraste conforme au niveau décidé (AA proposé).
- Focus visible, navigation clavier complète.
- Les couleurs de lanes ne sont jamais le seul porteur d'information (forme, label, position).
- Les états CI ont un libellé, pas seulement une couleur.
- Les messages d'erreur sont annoncés et persistants.

## 8. Mise en œuvre

- P0 : tokens neutres et structure de panneaux, sans polish.
- P1 : composants de base, cohérence des états, densité.
- P2 : shell et écrans alignés sur la maquette de référence — barre supérieure
  avec onglets de dépôts, barre d'outils (branche, ahead/behind, fetch/pull/
  push), navigation groupée, barre d'état ; écrans Conflits (3 panneaux),
  Rebase interactif, Worktrees, Tags, Remotes, Submodules, Patches, Blame,
  Recherche approfondie, Merge requests (discussions/approbations/jobs),
  Profils et réglages ; palette de commandes, raccourcis configurables et
  thème sombre/clair.
- P3 : design system complet, animations avancées, audit visuel et
  accessibilité — livré : tokens espacement/typage/profondeur, densité
  compacte/confortable, primitives `Button` et `Dialog`, animations
  120–220 ms, audit contraste (texte ≥ 7:1, muted ≥ 4,5:1, lanes ≥ 3:1) et
  audit a11y automatisé.

### Implémentation P2 (tokens réels)

| Token | Sombre | Clair |
|---|---|---|
| `--bg` | `#101216` | `#F5F6F8` |
| `--surface` | `#15181E` | `#ECEEF2` |
| `--surface-raised` | `#1C2028` | `#E2E5EB` |
| `--border` | `#282D36` | `#D3D7DF` |
| `--text` | `#E1E5EC` | `#222936` |
| `--muted` | `#8992A2` | `#667184` |
| `--accent` | `#F5BB45` | `#F5BB45` |
| `--success` | `#52C993` | `#136B46` |
| `--warning` | `#F0A45B` | `#94470A` |
| `--error` | `#E66B75` | `#B93B48` |
| `--info` | `#81A9EF` | `#2B6CB0` |

Les animations sont limitées à 120–160 ms et désactivées avec
`prefers-reduced-motion`. Les raccourcis clavier sont configurables dans
Profils et réglages ; les doublons sont refusés.

Toute évolution visuelle doit respecter les garde-fous de la section 3.

### Rendu du graphe (référence GitKraken)

Le graphe suit les conventions de lecture GitKraken sans reprendre ses assets :

- chaque ligne de commit est une **bande teintée** par la couleur de la branche
  (6 % en sombre, 5 % en clair), avec 3 px de retrait haut/bas et des angles de
  4 px ; la sélection et la multi-sélection renforcent la teinte et ajoutent une
  barre d'accent à gauche ;
- les références sont des **pastilles colorées par type** — accent pour HEAD,
  couleur de lane pour une branche locale, `--info` pour une branche distante,
  `--warning` pour un tag — avec l'icône correspondante (fourche, nuage,
  étiquette) ; toutes les références visibles sont dessinées, le surplus devient
  `+N` et ouvre le menu des références ;
- les nœuds sont des disques de la couleur de lane, cerclés de `--surface` pour
  se détacher des lignes ; HEAD reçoit un halo d'accent ;
- les **jonctions de lane** sont arrondies sur la ligne du commit d'arrivée,
  comme dans GitKraken : une branche qui rejoint son parent garde sa colonne
  jusqu'à la ligne du parent puis courbe **au-dessus** de la médiane ; seul un
  parent secondaire ouvre une colonne **sous** le commit, avec un arrondi sous
  la médiane. Un commit dont le parent est déjà pris par une autre colonne
  n'abandonne donc plus sa colonne prématurément ;
- un **stash** est un nœud à part, en tête de l'historique : médaillon carré
  arrondi en pointillés avec un coffre, dans la couleur de lane, et libellé par
  le message saisi (sans le préfixe `On <branche>:`). Ses instantanés `index`
  et `untracked` restent hors du graphe : un stash = une ligne ;
- **épingler à gauche** ancre une branche en première colonne à partir de son
  sommet : les colonnes 0 et n échangent leur place à la ligne du sommet, qui
  dessine la bascule, sans déplacer les nœuds au-dessus. **Solo** réduit le
  graphe à une branche via le filtre, sans modifier le dépôt ;
- l'espacement des lanes est fixe (22 px) et la colonne des branches suit le
  libellé le plus long (96 à 220 px), en réservant 520 px au message et 90 px à
  l'auteur pour ne jamais tronquer le sujet.

Les contrastes texte/fond des pastilles restent ≥ 4,5:1 (mesuré ≥ 7:1 en sombre).

### Implémentation P3 (tokens complémentaires)

| Famille | Tokens |
|---|---|
| Espacement | `--space-1` … `--space-12` (base 4 px) |
| Typographie | `--text-xs` … `--text-2xl`, `--line-tight`, `--line-normal` |
| Densité | `--row-height`, `--control-height` ; `data-density="compact"` (13 px / 26 px) ou `"comfortable"` (15 px / 34 px) |
| Profondeur | `--z-base` … `--z-toast`, `--shadow-sm`, `--shadow-md`, `--focus-ring` |
| Mouvement | `--duration-fast` 120 ms, `--duration-normal` 160 ms, `--duration-slow` 220 ms |

Les couleurs de lanes claires sont assombries pour rester ≥ 3:1 sur le fond
clair ; le jaune d'accent n'est jamais une lane. Les animations de vue,
dialogues et overlays sont désactivées intégralement avec
`prefers-reduced-motion`.
