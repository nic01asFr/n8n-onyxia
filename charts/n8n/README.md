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

Le Secret de la release contient `N8N_ENCRYPTION_KEY`, `OWNER_EMAIL`, `OWNER_PASSWORD` et `MCP_AUTH_TOKEN`. Une valeur vide est tirée au sort une fois, puis relue dans le Secret aux mises à jour (`lookup`). La clé de chiffrement est à sauvegarder : sans elle, les credentials sont illisibles.

```bash
kubectl get secret <release> -o jsonpath='{.data.N8N_ENCRYPTION_KEY}' | base64 -d
```

## Conventions Onyxia suivies

- `library-chart` InseeFrLab pour l'ingress de l'éditeur, la route, les NetworkPolicy et la découverte PostgreSQL.
- Fichiers `ingress-1-ui.yaml` puis `ingress-2-mcp.yaml` : l'éditeur reste la première URL du service.
- NOTES en markdown : première URL citée = bouton « Ouvrir » ; ligne `password: <valeur>` = bouton « Copier le mot de passe ».
- Le chart ne crée pas le Secret `sh.onyxia.release.v1.<release>` : Onyxia le crée après une installation depuis le catalogue et échouerait s'il existait déjà. `install.sh` le pose pour la voie ligne de commande.
- Placeholders `x-onyxia` sans espaces : `{{ user.email }}` n'est pas résolu par Onyxia.

## Sécurité du pod

Trois conteneurs en uid 1000, sans capacité Linux, sans escalade de privilèges, profil seccomp `RuntimeDefault`, sans jeton de ServiceAccount monté. L'image n8n-mcp déclare un utilisateur non numérique : elle tourne elle aussi en uid 1000, avec sa base de nœuds sur un volume temporaire (`NODE_DB_PATH`).
