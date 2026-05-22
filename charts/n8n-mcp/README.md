# n8n-mcp-onyxia

Chart Helm pour déployer le **serveur MCP n8n** ([czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp)) dans une instance Onyxia SSPCloud. Mode HTTP streamable, auth Bearer, intégration complète avec une instance n8n existante (39 tools pour interroger, créer, valider et déboguer des workflows depuis un agent LLM).

## Pré-requis

1. Une instance n8n accessible (en cluster via Service ClusterIP, ou publique).
2. Une **clé d'API n8n** créée dans n8n → Settings → API.
3. Un **token MCP** (généré aléatoirement, requis pour le Bearer).

## Installation pas à pas

### 1 — Créer le Secret K8s avec les deux clés

```powershell
# Token MCP (Bearer pour les clients) — généré aléatoirement
$MCP_TOKEN = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })

# Clé API n8n récupérée dans l'UI n8n
$N8N_API_KEY = "eyJ..."

kubectl create secret generic n8n-mcp-credentials `
  --from-literal=AUTH_TOKEN=$MCP_TOKEN `
  --from-literal=N8N_API_KEY=$N8N_API_KEY `
  -n user-<idep>

# Sauvegarder le token MCP : il sert à tous les clients (Claude, etc.)
Write-Output "MCP_TOKEN = $MCP_TOKEN"
```

### 2 — helm install

```powershell
helm install n8n-mcp . `
  --kube-context sspcloud `
  -n user-<idep> `
  -f examples/values-sspcloud.yaml `
  --set "mcp.host=user-<idep>-n8n-mcp.user.lab.sspcloud.fr" `
  --set "n8n.apiUrl=http://n8n.user-<idep>.svc.cluster.local:5678"
```

### 3 — Tester l'endpoint

```powershell
$TOKEN = kubectl get secret n8n-mcp-credentials -n user-<idep> -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d
curl -H "Authorization: Bearer $TOKEN" https://user-<idep>-n8n-mcp.user.lab.sspcloud.fr/health
# → {"status":"ok",...}
```

## Configuration client MCP

### Claude Code (CLI)

```bash
claude mcp add n8n --transport http https://user-<idep>-n8n-mcp.user.lab.sspcloud.fr/mcp \
  --header "Authorization: Bearer <AUTH_TOKEN>"
```

### Claude Desktop

`~/AppData/Roaming/Claude/claude_desktop_config.json` (Windows) ou `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) :

```json
{
  "mcpServers": {
    "n8n": {
      "transport": {
        "type": "streamable-http",
        "url": "https://user-<idep>-n8n-mcp.user.lab.sspcloud.fr/mcp",
        "headers": {
          "Authorization": "Bearer <AUTH_TOKEN>"
        }
      }
    }
  }
}
```

### Cursor / autres clients

Le serveur expose la spec MCP standard sur `/mcp` (POST JSON-RPC). Tout client compatible MCP Streamable HTTP fonctionne.

## Tools MCP exposés

39 tools pour interagir avec n8n (extraits) :

- `n8n_list_workflows` / `n8n_get_workflow` / `n8n_create_workflow` / `n8n_update_workflow`
- `n8n_execute_workflow_webhook` (déclencher)
- `n8n_list_executions` / `n8n_get_execution` (debug)
- `tools_documentation` (auto-doc)
- `list_nodes` / `get_node_info` / `get_node_essentials` (catalogue nodes n8n)
- `validate_node_operation` / `validate_workflow_connections` / `validate_workflow_expressions`
- `get_workflow_diff` / `update_partial_workflow` (édition diff)

Liste complète : voir [czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp#tools).

## Sécurité

- Token MCP transmis exclusivement en header `Authorization: Bearer`.
- Connexion à n8n via Service interne au cluster (`*.svc.cluster.local`) → pas de TLS, pas de traversée Internet.
- Clé API n8n stockée dans un Secret K8s, jamais dans values.yaml ni git.
- Possible de restreindre `corsOrigin` à un domaine précis si l'UI MCP est utilisée depuis un client web identifié.

## Désinstallation

```powershell
helm uninstall n8n-mcp -n user-<idep> --kube-context sspcloud
# Le Secret n8n-mcp-credentials n'est PAS supprimé (créé hors chart).
# Pour le supprimer :
kubectl delete secret n8n-mcp-credentials -n user-<idep> --context sspcloud
```

## Licence

Chart : MIT  
n8n-mcp : MIT (czlonkowski)
