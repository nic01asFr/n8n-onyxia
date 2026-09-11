# Fichiers repris de Widgets Grist

`engine.js`, `types.js` et `dsfr-like.css` sont des copies à l'identique de
`Widgets Grist/projects/grist_forms` (commit `aedf06d`, 2026-09-06) :

| Fichier | Source |
|---|---|
| `engine.js` | `runtime/engine.js` |
| `types.js` | `shared/types.js` |
| `dsfr-like.css` | `shared/dsfr-like.css` |

Ne pas les modifier ici : une correction se fait dans grist_forms, puis la copie
est reprise. Le portail n'utilise du moteur que `FormEngine.mount` avec un
`bridge.submit` : les pièces jointes, l'audience et les listes liées à des
tables Grist ne sont pas branchées.

Demande en cours auprès de grist_forms : un crochet `bridge.onSuccess(result,
rootEl)` pour afficher le retour de l'action à la place du message de succès.
En attendant, `app.js` remplace l'écran de succès une fois celui-ci rendu.
