# n8n-onyxia

> **n8n + serveur MCP, déployés en une commande sur SSPCloud Onyxia.**
>
> Une instance d'automatisation no-code complète, accessible publiquement par webhooks, branchable à Claude Code / Claude Desktop pour piloter tes workflows depuis un LLM. Tout en 2 minutes, zéro config.

---

## Installation en une commande

Depuis n'importe quel **terminal de pod Jupyter SSPCloud** (qui a déjà `kubectl` + `helm` préconfigurés) :

```bash
curl -sL https://nic01asfr.github.io/n8n-onyxia/install.sh | bash
```

Le script fait tout :

1. Détecte ton namespace et ton email automatiquement
2. Déploie **n8n** (UI workflow + base SQLite + ingress TLS)
3. Crée le compte owner + génère une clé API
4. Déploie **n8n-mcp** (serveur MCP avec auth Bearer)
5. Affiche un récap copy-paste avec URLs et tokens

**Résultat après 2 min** : tu as ces deux URLs accessibles depuis Internet :

| Service | URL |
|---|---|
| UI n8n | `https://user-<idep>-n8n.user.lab.sspcloud.fr` |
| MCP n8n | `https://user-<idep>-n8n-mcp.user.lab.sspcloud.fr/mcp` |

…plus le mot de passe owner et les tokens, prêts à coller dans Claude.

---

## À quoi ça sert ?

**n8n** est un outil d'automatisation no-code (équivalent open source de Zapier / Make). Tu connectes des nœuds visuellement pour orchestrer des APIs, traiter des webhooks, planifier des tâches.

- Reçois des webhooks depuis GitHub, Stripe, Telegram, etc.
- Appelle n'importe quelle API : Gmail, Slack, Notion, OpenAI…
- Planifie des cron jobs
- Branche sur ta base de données, ton S3, ton stockage

**n8n-mcp** branche ton n8n à un LLM (Claude, GPT…) via le protocole MCP. Le LLM peut alors :

- Lister et lire tes workflows
- Créer / éditer / déboguer des workflows en langage naturel
- Déclencher des exécutions et lire les logs
- Connaître le catalogue complet des nœuds n8n

→ Tu décris ce que tu veux à Claude, il construit le workflow pour toi.

---

## Brancher Claude Code

Une fois `install.sh` terminé, le récap te donne la commande exacte. En résumé :

```bash
claude mcp add n8n --transport http \
  https://user-<idep>-n8n-mcp.user.lab.sspcloud.fr/mcp \
  --header "Authorization: Bearer <TON_TOKEN>"
```

Puis dans Claude Code : `/mcp` pour vérifier. Prompt-test :
> Liste les nœuds n8n disponibles pour parler à GitHub

Le LLM appelle `search_nodes` du MCP → te répond avec la liste précise.

## Brancher Claude Desktop

Si ta version de Claude Desktop supporte les **Custom Connectors** (Settings → Connectors → Add custom), entre les paramètres affichés. Sinon, ajoute dans `%APPDATA%\Claude\claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "n8n": {
      "command": "npx",
      "args": ["-y", "mcp-remote",
        "https://user-<idep>-n8n-mcp.user.lab.sspcloud.fr/mcp",
        "--header", "Authorization: Bearer <TON_TOKEN>"]
    }
  }
}
```
*(Node.js requis pour `mcp-remote`. Restart complet de Claude Desktop ensuite.)*

---

## Méthodes alternatives d'installation

### A. Catalogue Onyxia (zéro CLI)

Dans SSPCloud → **Mon compte** → **Services** → *Sources des services personnalisés* → ajoute :

```
https://nic01asfr.github.io/n8n-onyxia
```

Les charts `n8n` et `n8n-mcp` apparaissent ensuite dans ton catalogue, lançables avec un formulaire pré-rempli (Onyxia injecte ton idep, email, etc.).

### B. Helm direct (utilisateur avancé)

```bash
helm repo add nic01asfr https://nic01asfr.github.io/n8n-onyxia
helm repo update
helm install n8n nic01asfr/n8n \
  -f https://nic01asfr.github.io/n8n-onyxia/values-sspcloud.yaml \
  --set owner.email=mon@email.fr \
  --set n8n.host=user-MONIDEP-n8n.user.lab.sspcloud.fr
helm install n8n-mcp nic01asfr/n8n-mcp \
  -f https://nic01asfr.github.io/n8n-onyxia/values-sspcloud-mcp.yaml \
  --set mcp.host=user-MONIDEP-n8n-mcp.user.lab.sspcloud.fr \
  --set n8n.apiUrl=http://n8n.user-MONIDEP.svc.cluster.local:5678
```

À noter : avec cette méthode, la création automatique de la clé API n8n n'est pas faite — il faut soit la créer via l'UI puis patcher le Secret, soit laisser tomber `install.sh` du repo qui le fait pour toi.

---

## Structure du repo

```
n8n-onyxia/
├── charts/
│   ├── n8n/              # Chart Helm n8n (UI + persistence + ingress TLS)
│   └── n8n-mcp/          # Chart Helm serveur MCP
├── scripts/
│   └── install.sh        # Orchestrateur one-liner
└── .github/workflows/
    └── release.yml       # CI : package + publie sur GitHub Pages
```

Détails par chart :
- [charts/n8n/README.md](charts/n8n/README.md)
- [charts/n8n-mcp/README.md](charts/n8n-mcp/README.md)

---

## Sauvegardes critiques

Le script génère 3 secrets qu'**il faut sauvegarder hors-cluster** (gestionnaire de mots de passe / Vault) :

| Secret | Pourquoi |
|---|---|
| `ownerPassword` | Pour te logger dans l'UI n8n |
| `encryptionKey` | Chiffre tes credentials stockées dans n8n (Gmail, Slack, etc.). **Perdue → tous les credentials irrécupérables.** |
| `AUTH_TOKEN` MCP | Pour que Claude puisse parler au MCP |

Pour les ré-extraire à tout moment :
```bash
NS=user-$(whoami | cut -d- -f2)  # ou ton idep direct
kubectl -n $NS get secret n8n -o jsonpath='{.data.ownerPassword}' | base64 -d
kubectl -n $NS get secret n8n -o jsonpath='{.data.encryptionKey}' | base64 -d
kubectl -n $NS get secret n8n-mcp -o jsonpath='{.data.AUTH_TOKEN}' | base64 -d
```

---

## Limites connues

| Catégorie | Limite | Atténuation |
|---|---|---|
| **Scaling** | Mono-pod (SQLite + PVC RWO). Pas de multi-réplique. | Passer en PostgreSQL + mode queue (non fourni pour l'instant). |
| **Workflows en cours** | Redémarrage du pod = exécution interrompue. | Workflows critiques : monitor externe + retry. |
| **OAuth** | Callback URL fixe → changer le hostname casse les credentials OAuth. | Ne pas changer le hostname une fois en prod. |
| **Backup** | Pas de backup auto (workflows + SQLite). | CronJob de backup vers S3 SSPCloud à ajouter. |
| **N8N_ENCRYPTION_KEY** | Si perdue, credentials irrécupérables. | Sauvegarde obligatoire. |
| **IP sortante** | Pas d'IP fixe (NAT partagé). | Services exigeant IP allowlist : proxy intermédiaire. |
| **Port 25 SMTP** | Bloqué (standard cloud). | Utiliser 587/465. |
| **Claude Desktop** | Pas de HTTP MCP natif avant version récente. | Bridge `mcp-remote` requis (Node.js). |

Détail technique complet : voir les README individuels des charts.

---

## Désinstallation

```bash
helm uninstall n8n-mcp -n user-<idep>
helm uninstall n8n     -n user-<idep>

# Les Secrets + PVC sont conservés (resource-policy: keep).
# Pour TOUT supprimer y compris données :
kubectl delete pvc n8n -n user-<idep>
kubectl delete secret n8n n8n-mcp -n user-<idep>
```

---

## Contribuer

Mono-repo Helm. À chaque push sur `main` qui touche `charts/` ou `scripts/`, un workflow GitHub Actions repackage tout et publie sur la branche `gh-pages`.

Pour tester localement :
```bash
git clone https://github.com/nic01asFr/n8n-onyxia.git
cd n8n-onyxia
helm lint charts/n8n charts/n8n-mcp
helm template test charts/n8n --set owner.email=test@test.com --set n8n.host=test.local
bash -n scripts/install.sh   # vérifier la syntaxe
```

Pour bumper une version, modifier `version:` dans `charts/<chart>/Chart.yaml` puis push.

---

## Licence

- **Charts (ce repo)** : MIT
- **n8n** : [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/) (usage interne OK, redistribution commerciale = lire la licence)
- **n8n-mcp** : MIT ([czlonkowski/n8n-mcp](https://github.com/czlonkowski/n8n-mcp))
