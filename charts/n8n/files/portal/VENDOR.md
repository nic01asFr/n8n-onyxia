# Fichiers repris de Widgets Grist

`engine.js` et `types.js` sont des copies à l'identique de
`Widgets Grist/projects/grist_forms` (commit `aedf06d`, 2026-09-06) :

| Fichier | Source |
|---|---|
| `engine.js` | `runtime/engine.js` |
| `types.js` | `shared/types.js` |

Ne pas les modifier ici : une correction se fait dans grist_forms, puis la copie
est reprise. Le portail n'utilise du moteur que `FormEngine.mount` avec un
`bridge.submit` : les pièces jointes, l'audience et les listes liées à des
tables Grist ne sont pas branchées.

Le formulaire rendu garde les classes `fr-*` du moteur ; `portal.css` les
habille à l'identité du portail. La feuille `dsfr-like.css` de grist_forms n'est
plus chargée.

Demande en cours auprès de grist_forms : un crochet `bridge.onSuccess(result,
rootEl)` pour afficher le retour de l'action à la place du message de succès,
et un rendu qui ne reconstruit pas le formulaire à chaque saisie. En attendant,
`app.js` remplace l'écran de succès une fois celui-ci rendu, et garde le focus
sur les boutons (`keepFocusOnButtons`).
