# n8n-onyxia

Charts Helm pour déployer **n8n** (automatisation de workflows) et son **serveur MCP** (Model Context Protocol pour LLM) dans un namespace SSPCloud Onyxia. Auto-provisionning de l'owner + clé API, intégration TLS native, persistance PVC.

## Quickstart — une commande

Depuis un terminal de pod Jupyter SSPCloud (qui a déjà `kubectl` + `helm` configurés) :

```bash
curl -sL https://nic01asfr.github.io/n8n-onyxia/install.sh | bash
```

Le script :
1. Détecte ton namespace SSPCloud
2. Demande ton email (sinon récupéré depuis `git config --global user.email`)
3. Installe **n8n** + **n8n-mcp** dans le namespace
4. Attend que le Job de provisioning crée automatiquement la clé API n8n
5. Affiche un récap avec URLs + tokens prêts à coller dans Claude Code/Desktop

Durée : ~2 minutes. Idempotent (re-exécution = upgrade).

## Méthodes alternatives

### Helm direct (utilisateur avancé)

```bash
helm repo add nic01asfr https://nic01asfr.github.io/n8n-onyxia
helm repo update
helm install n8n nic01asfr/n8n \
  -f https://nic01asfr.github.io/n8n-onyxia/values-sspcloud.yaml \
  --set owner.email=mon@email.fr \
  --set n8n.host=user-MONIDEP-n8n.user.lab.sspcloud.fr
```

### Catalogue Onyxia (zéro CLI)

SSPCloud → **Mon compte** → **Services** → *Sources des services personnalisés* → ajouter :
```
https://nic01asfr.github.io/n8n-onyxia
```
Les charts apparaissent ensuite dans ton catalogue, lançables avec un formulaire et un clic.

## Structure du repo

```
n8n-onyxia/
├── charts/
│   ├── n8n/              # Chart Helm n8n (UI + workflows + auto-provisioning)
│   └── n8n-mcp/          # Chart Helm serveur MCP (czlonkowski/n8n-mcp)
├── scripts/
│   └── install.sh        # Orchestrateur d'installation one-liner
└── .github/workflows/
    └── release.yml       # CI : package + publie sur GitHub Pages
```

## Ce qui est inclus

### Chart `n8n`
- Image officielle `n8nio/n8n:1.80.3`
- Persistance PVC (workflows, credentials, SQLite ou PostgreSQL)
- Ingress TLS auto (Let's Encrypt via ingress controller SSPCloud)
- **Job post-install** qui crée l'owner + une clé API automatiquement
- Secrets (encryptionKey, ownerPassword, N8N_API_KEY) stables entre upgrades
- Webhooks externes activés sur l'URL publique

Voir [charts/n8n/README.md](charts/n8n/README.md).

### Chart `n8n-mcp`
- Image `ghcr.io/czlonkowski/n8n-mcp:latest`
- Mode HTTP streamable avec auth Bearer
- Token auto-généré stable entre upgrades
- Lit la clé API n8n depuis le Secret du chart n8n (auto-provisioning chaîné)
- 39 tools MCP pour interroger, créer, valider, débugger les workflows n8n depuis un LLM

Voir [charts/n8n-mcp/README.md](charts/n8n-mcp/README.md).

## Limites connues

| Catégorie | Limite |
|---|---|
| Scaling | Mono-pod (SQLite + PVC RWO). Pour multi-réplique : passer en PostgreSQL + mode queue (non fourni). |
| Sécurité | Bearer token MCP unique, pas de multi-user. Sécurité = ne pas leak le token. |
| OAuth | Callback URL fixe → changer le hostname casse les credentials OAuth stockées. |
| Backup | Pas de backup auto. À ajouter via CronJob → S3 SSPCloud. |
| N8N_ENCRYPTION_KEY | Si perdue, tous les credentials sont irrécupérables. Sauvegarde obligatoire. |
| IP sortante | Pas de IP publique fixe (NAT partagé SSPCloud). Services externes exigeant IP allowlist : passer par proxy. |
| Port 25 SMTP | Bloqué (standard cloud). Utiliser 587/465. |
| Client Claude Desktop | Pas de support HTTP MCP natif avant version récente → bridge `mcp-remote` requis. |

Voir [docs/limites.md](docs/limites.md) pour la liste exhaustive.

## Désinstallation

```bash
helm uninstall n8n-mcp -n user-MONIDEP
helm uninstall n8n -n user-MONIDEP

# Les Secrets et PVC sont conservés (helm.sh/resource-policy: keep).
# Pour TOUT supprimer :
kubectl delete pvc n8n -n user-MONIDEP
kubectl delete secret n8n n8n-mcp -n user-MONIDEP
```

## Contribuer

Le repo est un mono-repo Helm. Les charts sont versionnés indépendamment via `charts/<chart>/Chart.yaml`. À chaque push sur `main` qui touche `charts/`, un workflow GitHub Actions repackage les charts et publie sur la branche `gh-pages`.

Pour tester localement :
```bash
git clone https://github.com/nic01asFr/n8n-onyxia.git
cd n8n-onyxia
helm lint charts/n8n
helm template test charts/n8n --set owner.email=test@example.com --set n8n.host=test.local
```

## Licence

Charts : MIT  
n8n : [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)  
n8n-mcp : MIT (czlonkowski)
