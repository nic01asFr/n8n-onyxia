# Chart `n8n`

n8n pour Onyxia, avec serveur MCP intégré. Vue d'ensemble et installation : [README du dépôt](../../README.md).

## Valeurs principales

| Valeur | Défaut | Rempli par Onyxia | Rôle |
|---|---|---|---|
| `ingress.hostname` | vide (obligatoire) | `{{project.id}}-n8n-{{k8s.randomSubdomain}}.{{k8s.domain}}` | Hôte de l'éditeur et des webhooks |
| `mcp.hostname` | vide (obligatoire si MCP) | `{{project.id}}-n8n-mcp-{{k8s.randomSubdomain}}.{{k8s.domain}}` | Hôte du serveur MCP |
| `ingress.ingressClassName` | vide | `{{k8s.ingressClassName}}` | `onyxia` sur SSPCloud |
| `security.email` | vide | `{{user.email}}` | Identifiant owner |
| `security.password` | vide | `{{service.oneTimePassword}}` | Mot de passe owner, préfixé `N8n-` s'il manque majuscule ou chiffre |
| `security.allowlist.*` | désactivé | `region.defaultIpProtection`, `{{user.ip}}` | Restriction par IP |
| `security.networkPolicy.*` | désactivé | `region.defaultNetworkPolicy` | Politique réseau |
| `mcp.enabled` | `true` | | Serveur MCP dans le pod |
| `mcp.token` | dérivé du mot de passe | | Jeton Bearer du MCP |
| `mcp.securityMode` | `moderate` | | Protection SSRF des outils MCP |
| `portal.enabled` | `false` | | Portail d'actions : widget Grist qui lance des workflows choisis |
| `portal.hostname` | vide (obligatoire si portail) | `{{project.id}}-n8n-portail-{{k8s.randomSubdomain}}.{{k8s.domain}}` | Hôte du portail |
| `portal.adminToken` | dérivé du mot de passe | | Jeton du mode « Configurer » |
| `portal.gristOrigins` | grist.numerique.gouv.fr, docs.getgrist.com | | Sites Grist acceptés et autorisés à intégrer le portail |
| `provisioning.enabled` | `true` | | Création de l'owner et de la clé API |
| `provisioning.apiKeyScopePrefixes` | workflows, exécutions, étiquettes, tables, credentials, dossiers | | Droits de la clé API du MCP |
| `database.type` | `sqlite` | | `postgresdb` pour un PostgreSQL externe |
| `discovery.postgresql` | `false` | | Utiliser le PostgreSQL Onyxia du projet |
| `persistence.size` | `5Gi` | `{{region.resources.disk}}` | Volume `/home/node/.n8n` |
| `persistence.keepOnUninstall` | `false` | | Garder volume et Secret après suppression (`true` via `install.sh`) |
| `n8n.userFolder` | `/home/node` | | `/home/node/.n8n` pour reprendre un volume des charts 0.x |
| `global.suspend` | `false` | | Mise en veille : zéro réplique, volume conservé |
| `userPreferences.language` | `fr` | `{{user.lang}}` | Langue des notes |

Liste complète et commentée : [values.yaml](values.yaml). Formulaire : [values.schema.json](values.schema.json).

## Secrets

Le Secret de la release contient `N8N_ENCRYPTION_KEY`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `MCP_AUTH_TOKEN` et, portail activé, `PORTAL_ADMIN_TOKEN`. Une valeur vide est tirée au sort une fois, puis relue dans le Secret aux mises à jour (`lookup`). La clé de chiffrement est à sauvegarder : sans elle, les credentials sont illisibles.

```bash
kubectl get secret <release> -o jsonpath='{.data.N8N_ENCRYPTION_KEY}' | base64 -d
```

## Conventions Onyxia suivies

- `library-chart` InseeFrLab pour l'ingress de l'éditeur, la route, les NetworkPolicy et la découverte PostgreSQL.
- Fichiers `ingress-1-ui.yaml` puis `ingress-2-mcp.yaml` : l'éditeur reste la première URL du service.
- NOTES en markdown : première URL citée = bouton « Ouvrir » ; ligne `password: <valeur>` = bouton « Copier le mot de passe ». Le texte d'un lien ne doit pas être l'URL elle-même : Onyxia lirait `url](url` comme adresse. La CI rejoue l'extraction d'Onyxia sur les notes rendues.
- Un service n'apparaît dans « Mes services » que si son propriétaire est l'utilisateur connecté (filtre de l'interface web) : sans le Secret `sh.onyxia.release.v1.<release>`, une installation en ligne de commande reste invisible.
- Le chart ne crée pas le Secret `sh.onyxia.release.v1.<release>` : Onyxia le crée après une installation depuis le catalogue et échouerait s'il existait déjà. `install.sh` le pose pour la voie ligne de commande.
- Placeholders `x-onyxia` sans espaces : `{{ user.email }}` n'est pas résolu par Onyxia.

## Portail d'actions

Le propriétaire choisit des workflows et les transforme en actions : un formulaire guidé (contrat FormDef de Widgets Grist, étendu par `target` et `result`) que les personnes ayant accès à un document Grist lancent depuis un widget.

- **Seule porte publique.** Le portail appelle les webhooks sur localhost : ils n'ont pas à être exposés, et l'allowlist IP de l'éditeur ne gêne pas les destinataires.
- **Identité vérifiée.** Chaque appel porte le jeton `getAccessToken` du lecteur. Le portail le présente à Grist (hôtes de `portal.gristOrigins` uniquement) et ne lit l'utilisateur et le document dans ce jeton que si Grist l'accepte.
- **Droits dans le service.** Les actions exposées, les documents qui les ouvrent et le compte propriétaire sont dans `onyxia/portail.json` sur le volume. Un éditeur du document ne peut rien s'y ouvrir.
- **Entrées contrôlées côté serveur.** Seuls les champs déclarés passent, convertis et bornés. Le workflow reçoit les entrées à plat (`$json.body.<champ>`) et le contexte sous `$json.body._portail` : `runId`, `action`, `requester.gristUserId`, `document.docId`.
- **Déclencheur accepté** : Webhook en POST, sans paramètre de chemin ni authentification propre, workflow publié.

Code : [files/portal/](files/portal/). Tests : `node --test tests/portal/*.test.mjs`. Aperçu local sans Grist ni n8n : `node tests/portal/dev-server.mjs`.

## Sécurité du pod

Jusqu'à quatre conteneurs en uid 1000, sans capacité Linux, sans escalade de privilèges, profil seccomp `RuntimeDefault`, sans jeton de ServiceAccount monté. L'image n8n-mcp déclare un utilisateur non numérique : elle tourne elle aussi en uid 1000, avec sa base de nœuds sur un volume temporaire (`NODE_DB_PATH`).
