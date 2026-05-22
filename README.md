# n8n-onyxia

Chart Helm pour déployer **n8n** (automatisation de workflows) dans une instance Onyxia SSPCloud, avec :

- Persistance PVC (workflows, credentials, SQLite) survivant aux redémarrages
- Ingress public TLS auto (cert-manager) — webhooks externes activés
- Clé de chiffrement stable entre upgrades (préservée via `lookup` du Secret existant)
- Formulaire de configuration intégré au catalogue Onyxia (`values.schema.json`)
- Choix SQLite (mono-pod, simple) ou PostgreSQL externe (scalable) au déploiement
- Conforme aux contraintes SSPCloud : `runAsNonRoot`, UID 1000, pas de root, pas de hostPath

## Structure

```
n8n-onyxia/
├── Chart.yaml              # Métadonnées du chart
├── values.yaml             # Valeurs par défaut (commentées en français)
├── values.schema.json      # Schéma du formulaire Onyxia
├── templates/
│   ├── _helpers.tpl        # Helpers Helm + résolution stable encryptionKey
│   ├── deployment.yaml     # Pod n8n avec env complet
│   ├── service.yaml        # ClusterIP port 5678
│   ├── ingress.yaml        # Ingress nginx + TLS Let's Encrypt
│   ├── pvc.yaml            # PVC keep-on-uninstall pour /home/node/.n8n
│   ├── secret.yaml         # N8N_ENCRYPTION_KEY + PG password (keep)
│   └── NOTES.txt           # Affiché après helm install
├── .helmignore
└── .gitignore
```

## Déploiement dans Onyxia SSPCloud

### 1 — Publier le chart sur un dépôt Helm accessible

Plusieurs options :

#### A. GitHub Pages (le plus simple)

```powershell
# Depuis ce repo
helm package .
helm repo index . --url https://<ton-user>.github.io/n8n-onyxia
# Pousser tout sur la branche gh-pages
```

#### B. Repo Helm local pour test

```powershell
helm package .
# Servir le dossier via n'importe quel HTTP statique (Caddy, nginx, python -m http.server)
helm repo index . --url http://localhost:8000
```

### 2 — Ajouter le dépôt dans Onyxia

1. Onyxia → **Mon compte** → onglet **Services**
2. Section **« Sources des services personnalisés »**
3. Coller l'URL du repo Helm publié (qui sert `index.yaml`)
4. Recharger le catalogue : n8n apparaît dans la liste

### 3 — Lancer le service

1. Catalogue → **n8n** → **Lancer**
2. Le formulaire propose :
   - Domaine public (par défaut `n8n-{random}.user-{idep}.lab.sspcloud.fr`)
   - Fuseau horaire, niveau de log
   - Base de données (SQLite / PostgreSQL)
   - Taille du PVC, ressources CPU/RAM
3. Cliquer **Lancer** → attendre 1-2 min que le pod soit prêt
4. Ouvrir l'URL → créer le compte owner

## Configuration locale (hors Onyxia)

Pour tester en CLI sur un cluster K8s arbitraire :

```bash
helm install mon-n8n . \
  --set n8n.host=n8n.mon-domaine.fr \
  --set persistence.size=10Gi \
  --namespace n8n --create-namespace
```

Pour passer en PostgreSQL :

```bash
helm install mon-n8n . \
  --set n8n.host=n8n.mon-domaine.fr \
  --set database.type=postgresdb \
  --set database.postgres.host=postgres.svc.cluster.local \
  --set database.postgres.password='supersecret' \
  --namespace n8n
```

## Sauvegarde / restauration

### Sauvegarder la clé de chiffrement (CRITIQUE)

```bash
kubectl get secret mon-n8n-n8n \
  -n n8n \
  -o jsonpath='{.data.encryptionKey}' | base64 -d > n8n-encryption-key.txt
# À stocker hors-cluster (gestionnaire de mots de passe, Vault personnel)
```

### Sauvegarder les workflows (SQLite)

```bash
kubectl exec -n n8n deploy/mon-n8n-n8n -- \
  tar czf - -C /home/node/.n8n . > n8n-backup-$(date +%F).tar.gz
```

### Restaurer

```bash
# 1. Recréer le secret avec la clé sauvegardée
kubectl create secret generic mon-n8n-n8n \
  --from-literal=encryptionKey="$(cat n8n-encryption-key.txt)" \
  -n n8n

# 2. helm install (le secret existant sera réutilisé via lookup)
# 3. Restaurer les fichiers dans le PVC
kubectl cp n8n-backup.tar.gz n8n/mon-n8n-n8n-xxxxx:/tmp/
kubectl exec -n n8n deploy/mon-n8n-n8n -- \
  tar xzf /tmp/n8n-backup.tar.gz -C /home/node/.n8n
kubectl rollout restart deploy/mon-n8n-n8n -n n8n
```

## Limitations connues

- **Mono-pod uniquement** (réplique = 1) car PVC RWO + SQLite. Pour multi-réplique :
  passer en PostgreSQL + mode `queue` (Redis externe non géré par ce chart).
- **Premier démarrage long** (~60 s) le temps que SQLite s'initialise et que n8n
  télécharge les nodes du registre.
- **Webhooks** nécessitent que le hostname soit accessible depuis Internet. Sur
  SSPCloud le wildcard `*.lab.sspcloud.fr` est public — OK.
- **Pas d'OIDC Keycloak SSPCloud** : l'auth OIDC est dans n8n Enterprise (payant).
  Auth gérée par n8n built-in (email/password owner).

## Roadmap

- [ ] Mode `queue` avec Redis (sub-chart bitnami/redis)
- [ ] OAuth2 Proxy sidecar pour SSO Keycloak SSPCloud
- [ ] Init-container pour seeder un workflow d'exemple
- [ ] CronJob de backup automatique vers S3 SSPCloud

## Licence

Chart : MIT
n8n : [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)
