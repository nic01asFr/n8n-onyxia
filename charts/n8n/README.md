# Chart Helm `n8n`

Chart Helm pour [n8n](https://n8n.io) (automatisation no-code) prêt pour SSPCloud Onyxia.

> Si tu cherches juste à installer rapidement, va voir le [README à la racine du repo](../../README.md) — une seule commande `install.sh` fait n8n + le serveur MCP en une fois. Ce README détaille uniquement le chart `n8n` pour qui veut configurer finement.

## Ce qui est embarqué

| Composant | Détail |
|---|---|
| Image | `docker.n8n.io/n8nio/n8n:1.80.3` |
| Persistance | PVC `rook-ceph-block` 5-10 Gi (workflows + credentials + SQLite) |
| Ingress | TLS auto via ingress controller SSPCloud (Let's Encrypt) |
| BDD | SQLite par défaut (mono-pod) ou PostgreSQL externe (option) |
| Sécurité | `runAsNonRoot`, UID 1000, pas de hostPath, conforme contraintes SSPCloud |
| Webhooks | Activés sur l'URL publique (`/webhook/...`) |
| Auto-provisioning | Owner + clé API (optionnel, désactivé par défaut, activable côté script) |

## Installation manuelle

```bash
helm repo add nic01asfr https://nic01asfr.github.io/n8n-onyxia
helm repo update

IDEP=monidep
helm install n8n nic01asfr/n8n \
  --namespace user-$IDEP \
  -f https://nic01asfr.github.io/n8n-onyxia/values-sspcloud.yaml \
  --set n8n.host=user-$IDEP-n8n.user.lab.sspcloud.fr \
  --set owner.email=mon@email.fr
```

À la fin, l'UI est accessible sur `https://user-$IDEP-n8n.user.lab.sspcloud.fr`. Login avec :

```bash
kubectl -n user-$IDEP get secret n8n -o jsonpath='{.data.ownerEmail}' | base64 -d
kubectl -n user-$IDEP get secret n8n -o jsonpath='{.data.ownerPassword}' | base64 -d
```

## Configuration

Le formulaire Onyxia (`values.schema.json`) expose les paramètres essentiels :

| Section | Champ | Description |
|---|---|---|
| `n8n` | `host` | Domaine public (auto-rempli par Onyxia) |
| `n8n` | `timezone` | `Europe/Paris` par défaut |
| `n8n` | `logLevel` | error / warn / info / verbose / debug |
| `n8n` | `executionsMode` | `regular` (défaut) ou `queue` (Redis non géré) |
| `owner` | `email` | Email login UI |
| `owner` | `password` | Mot de passe (généré aléatoirement si vide) |
| `database` | `type` | `sqlite` ou `postgresdb` |
| `persistence` | `size` | Taille PVC (1Gi à 50Gi) |
| `resources` | `requests/limits` | CPU et RAM |
| `provisioning` | `enabled` | Job in-cluster (généralement **false** sur SSPCloud, voir ci-dessous) |

`values.yaml` complet : [charts/n8n/values.yaml](values.yaml).

## Pourquoi `provisioning.enabled: false` par défaut ?

Le chart contient un Job Helm (`templates/provisioning-job.yaml`) qui peut créer automatiquement l'owner n8n + une clé API. Mais ce Job a besoin d'un Role/RoleBinding K8s pour patcher le Secret de la release, ce que **SSPCloud refuse** (les users OIDC SSPCloud n'ont pas les droits `create`/`delete` sur les Roles dans leur propre namespace).

→ Le Job est laissé en place pour les clusters qui autorisent ça, mais désactivé par défaut. Sur SSPCloud, c'est le script [`scripts/install.sh`](../../scripts/install.sh) à la racine du repo qui fait l'équivalent côté client (en utilisant le kubectl de l'user qui a les droits patch Secret).

## Sauvegardes critiques

Les annotations `helm.sh/resource-policy: keep` sur le PVC et le Secret garantissent que **`helm uninstall` ne supprime pas les données**. Mais il faut quand même sauvegarder hors-cluster :

```bash
NS=user-$IDEP

# Clé de chiffrement n8n (CRITIQUE — credentials irrécupérables sans elle)
kubectl -n $NS get secret n8n -o jsonpath='{.data.encryptionKey}' | base64 -d

# Password owner
kubectl -n $NS get secret n8n -o jsonpath='{.data.ownerPassword}' | base64 -d

# Clé API n8n (si auto-provisionnée)
kubectl -n $NS get secret n8n -o jsonpath='{.data.N8N_API_KEY}' | base64 -d
```

Pour exporter les workflows + SQLite :
```bash
kubectl -n $NS exec deploy/n8n -- tar czf - -C /home/node/.n8n . > n8n-backup-$(date +%F).tar.gz
```

## Upgrade

```bash
helm upgrade n8n nic01asfr/n8n -n user-$IDEP \
  -f https://nic01asfr.github.io/n8n-onyxia/values-sspcloud.yaml \
  --set n8n.host=user-$IDEP-n8n.user.lab.sspcloud.fr \
  --set owner.email=mon@email.fr \
  --reuse-values
```

Les helpers `lookup`-based conservent **`encryptionKey`, `ownerPassword` et `N8N_API_KEY`** intacts entre upgrades — pas de regénération destructive.

## Désinstallation

```bash
helm uninstall n8n -n user-$IDEP
# Les Secrets et PVC persistent (resource-policy: keep). Pour TOUT supprimer :
kubectl delete secret n8n -n user-$IDEP
kubectl delete pvc    n8n -n user-$IDEP
```

## Limites spécifiques

- **Mono-pod uniquement** (réplique = 1) car PVC RWO + SQLite. Pour multi-réplique : passer en PostgreSQL + mode `queue` (sub-chart Redis non fourni).
- **Premier démarrage long** (~60 s) le temps que SQLite s'initialise.
- **Pas d'OIDC** : l'auth UI n8n c'est email/password owner (OIDC Keycloak nécessiterait n8n Enterprise + oauth2-proxy).
- **N8N_ENCRYPTION_KEY perdue** = tous les credentials chiffrés irrécupérables.

## Licence

Chart : MIT  
n8n : [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)
