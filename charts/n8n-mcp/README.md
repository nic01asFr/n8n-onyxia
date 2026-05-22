# Chart Helm `n8n-mcp`

Chart Helm pour [czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp) — serveur **Model Context Protocol** pour n8n, prêt pour SSPCloud Onyxia.

> Si tu cherches juste à installer, va voir le [README à la racine du repo](../../README.md). Ce chart est installé automatiquement par `scripts/install.sh` après n8n.

## C'est quoi MCP, déjà ?

**Model Context Protocol** (Anthropic) est un standard pour brancher un LLM à des outils externes. Une fois ce chart déployé, Claude (ou tout autre client MCP) peut parler à ton instance n8n via 39 outils :

- `n8n_list_workflows`, `n8n_get_workflow`, `n8n_create_workflow`, `n8n_update_partial_workflow`
- `n8n_execute_workflow_webhook`, `n8n_executions`
- `search_nodes`, `get_node`, `get_template`
- `validate_node`, `validate_workflow`, `n8n_autofix_workflow`
- `n8n_health_check`, `n8n_audit_instance`
- … et 25+ autres

Liste complète : [README du projet upstream](https://github.com/czlonkowski/n8n-mcp#tools).

## Ce qui est embarqué

| Composant | Détail |
|---|---|
| Image | `ghcr.io/czlonkowski/n8n-mcp:latest` |
| Transport | HTTP streamable (compatible Claude Code `--transport http`) |
| Auth | Bearer token (généré aléatoire 48 char, stable entre upgrades via `lookup`) |
| Endpoint MCP | `POST /mcp` |
| Healthcheck | `GET /health` (nécessite le Bearer) |
| n8n API | Lue depuis le Secret `n8n` du chart `n8n-onyxia` (auto) |
| Stateless | Pas de PVC, scalable horizontalement |

## Installation manuelle

Pré-requis : le chart `n8n` est déjà déployé dans le même namespace (le MCP lit le Secret `n8n` pour la clé API).

```bash
IDEP=monidep
NS=user-$IDEP

helm install n8n-mcp nic01asfr/n8n-mcp \
  --namespace $NS \
  -f https://nic01asfr.github.io/n8n-onyxia/values-sspcloud-mcp.yaml \
  --set mcp.host=user-$IDEP-n8n-mcp.user.lab.sspcloud.fr \
  --set n8n.apiUrl=http://n8n.$NS.svc.cluster.local:5678
```

Récupérer le token MCP :
```bash
kubectl -n $NS get secret n8n-mcp -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d
```

## Brancher un client MCP

### Claude Code

```bash
claude mcp add n8n --transport http \
  https://user-$IDEP-n8n-mcp.user.lab.sspcloud.fr/mcp \
  --header "Authorization: Bearer $TOKEN"
```

### Claude Desktop (via bridge `mcp-remote`)

```json
{
  "mcpServers": {
    "n8n": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
        "https://user-$IDEP-n8n-mcp.user.lab.sspcloud.fr/mcp",
        "--header", "Authorization: Bearer $TOKEN"]
    }
  }
}
```

### `.mcp.json` d'un projet (project-scoped)

```json
{
  "mcpServers": {
    "n8n": {
      "type": "http",
      "url": "https://user-$IDEP-n8n-mcp.user.lab.sspcloud.fr/mcp",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
```

## Configuration

Le formulaire Onyxia (`values.schema.json`) expose :

| Section | Champ | Description |
|---|---|---|
| `mcp` | `host` | Domaine public (auto-rempli par Onyxia) |
| `mcp` | `logLevel` | error / warn / info / debug |
| `mcp` | `corsOrigin` | `*` par défaut. Restreindre pour durcir. |
| `n8n` | `apiUrl` | URL de l'instance n8n (interne au cluster, `svc.cluster.local`) |
| `n8nApiSecret` | `name` | Secret K8s qui contient `N8N_API_KEY` (= `n8n` par défaut) |
| `resources` | `requests/limits` | CPU et RAM |
| `replicaCount` | | MCP stateless → scalable, par défaut 1 |

`values.yaml` complet : [charts/n8n-mcp/values.yaml](values.yaml).

## Sécurité

| Couche | Détail |
|---|---|
| **TLS** | Let's Encrypt auto via ingress controller |
| **Bearer token** | 48 chars random, ~285 bits d'entropie. Modèle MCP HTTP standard. |
| **Isolation** | MCP parle à n8n via Service interne `svc.cluster.local` (pas Internet) |
| **CORS** | `*` par défaut. Restreindre via `mcp.corsOrigin` pour bloquer les UI web tierces. |

→ Suffisant pour usage perso/équipe restreinte. Pour multi-user enterprise, ajouter un oauth2-proxy en sidecar (mais Claude Desktop ne supporte pas le flow OIDC pour MCP à date).

## Rotation du token

Pour révoquer + regénérer :

```bash
kubectl -n $NS delete secret n8n-mcp
helm upgrade n8n-mcp nic01asfr/n8n-mcp -n $NS --reuse-values
kubectl -n $NS rollout restart deploy/n8n-mcp
# Nouveau token :
kubectl -n $NS get secret n8n-mcp -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d
```

Puis mettre à jour la config Claude / `.mcp.json`.

## Désinstallation

```bash
helm uninstall n8n-mcp -n $NS
# Le Secret n8n-mcp est conservé (resource-policy: keep). Pour le supprimer :
kubectl delete secret n8n-mcp -n $NS
```

## Limites spécifiques

- **MCP Streamable HTTP stateful** : un client doit gérer le header `Mcp-Session-Id` après `initialize`. Le test naïf `curl /mcp/<method>` ne marche que pour `initialize`.
- **Claude Desktop ancien** : pas de transport HTTP natif → bridge `mcp-remote` requis (Node.js).
- **Pas de rate limiting** : un client peut bombarder le pod. À ajouter via annotations nginx ingress si besoin.
- **CORS = `*` par défaut** : tout origin web peut appeler avec le token. Restreindre si UI web exposée.
- **n8n-mcp tools dépendent de la version n8n** : si tu changes la version n8n, redémarre n8n-mcp pour recharger le catalogue de nœuds (`kubectl rollout restart deploy/n8n-mcp`).

## Licence

Chart : MIT  
n8n-mcp upstream : MIT ([czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp))
