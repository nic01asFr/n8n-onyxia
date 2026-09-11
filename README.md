# n8n-onyxia

**Présentation produit :** [nic01asfr.github.io/n8n-onyxia](https://nic01asfr.github.io/n8n-onyxia/) — ce README reste la doc technique.

Chart Helm qui lance [n8n](https://n8n.io) comme un service Onyxia (SSPCloud), avec un serveur [MCP](https://github.com/czlonkowski/n8n-mcp) intégré pour piloter les workflows depuis Claude, Cursor ou tout client MCP.

| | |
|---|---|
| n8n | 2.38.6 |
| n8n-mcp | 2.84.0 |
| Chart | 1.0.0, dépend de la `library-chart` InseeFrLab 2.1.7 |
| Dépôt Helm | `https://nic01asfr.github.io/n8n-onyxia` |

## Installer

### Depuis un terminal Jupyter SSPCloud

Lancer le service Jupyter avec le **rôle Kubernetes Edit** (le rôle View ne peut ni installer ni lire les Secrets), puis :

```bash
curl -sL https://nic01asfr.github.io/n8n-onyxia/install.sh | bash
```

Le script calcule les hôtes (`<namespace>-n8n.user.lab.sspcloud.fr` et `<namespace>-n8n-mcp.user.lab.sspcloud.fr`), génère le mot de passe owner, installe le chart et enregistre le service dans « Mes services ». Variables utiles : `OWNER_EMAIL`, `RELEASE`, `CHART_VERSION`, `SKIP_MCP=true`.

### Depuis le catalogue Onyxia

Un catalogue se déclare côté administrateurs de la plateforme (`onyxia.api.catalogs`), pas depuis le compte utilisateur. Une fois `https://nic01asfr.github.io/n8n-onyxia` référencé, le formulaire renseigne l'hôte, l'email (`{{user.email}}`), le mot de passe (`{{service.oneTimePassword}}`), la classe d'ingress et les réglages réseau de la région.

### Avec Helm

```bash
helm repo add n8n-onyxia https://nic01asfr.github.io/n8n-onyxia
helm install n8n n8n-onyxia/n8n \
  --set ingress.hostname=user-IDEP-n8n.user.lab.sspcloud.fr \
  --set mcp.hostname=user-IDEP-n8n-mcp.user.lab.sspcloud.fr \
  --set ingress.ingressClassName=onyxia \
  --set security.email=toi@exemple.fr \
  --set security.password=N8n-motdepasse
```

## Ce que fait le chart

Un seul pod, trois conteneurs :

| Conteneur | Rôle |
|---|---|
| `n8n` | L'éditeur et le moteur, données sur le volume monté en `/home/node/.n8n`. |
| `provisioning` | Crée le compte owner dès le démarrage, puis une clé API pour le MCP, par `localhost`. Aucun droit Kubernetes. Script : [charts/n8n/files/provision.mjs](charts/n8n/files/provision.mjs). |
| `mcp` | n8n-mcp, qui joint n8n sur `localhost` avec la clé déposée sur le volume et exige un jeton Bearer. |

Les notes du service (fenêtre « Ouvrir » d'Onyxia) affichent l'URL, l'identifiant, le mot de passe, l'adresse MCP, le jeton et la commande `claude mcp add` prête à coller.

Détail des valeurs : [charts/n8n/README.md](charts/n8n/README.md).

## Brancher Claude Code

```bash
claude mcp add n8n --transport http https://user-IDEP-n8n-mcp.user.lab.sspcloud.fr/mcp \
  --header "Authorization: Bearer <jeton affiché dans les notes>"
```

## Migrer depuis les charts 0.x

Les charts 0.x (n8n 1.x, chart `n8n-mcp` séparé) rangeaient les données dans `.n8n/.n8n` du volume et la clé sous `encryptionKey`. `install.sh` refuse de les mettre à jour. La procédure, éprouvée sur un cluster de test avec un credential créé en 0.2.0 puis relu en clair après migration, est décrite sur la [vitrine](https://nic01asfr.github.io/n8n-onyxia/#migration). Sauvegarder le volume et la clé avant.

## Limites

| Sujet | Limite |
|---|---|
| Réplicas | Un seul pod (SQLite sur volume ReadWriteOnce). PostgreSQL possible via `database.type` ou `discovery.postgresql`, sans mode queue. |
| Authentification | Compte n8n (email et mot de passe). Keycloak SSPCloud refuse les redirections vers les hôtes de services : pas d'OIDC. |
| Notes | Conservées par Helm dans le Secret de la release : qui lit les Secrets du namespace lit le mot de passe affiché. |
| Réseau sortant | Pas d'IP fixe, port 25 fermé (utiliser 587 ou 465). |
| Volume | Dans Onyxia, supprimer le service supprime le volume : exporter les workflows avant. |

## Développer

```bash
helm dependency update charts/n8n
helm lint charts/n8n --set ingress.hostname=a.example.org --set mcp.hostname=b.example.org
node --test site/generate.test.mjs
node site/generate.mjs   # vitrine dans site/dist
```

Un push sur `main` qui touche `charts/`, `scripts/` ou `site/` lance les tests, puis publie le chart, `install.sh` et la vitrine sur la branche `gh-pages`. Monter `version` dans `charts/n8n/Chart.yaml` à chaque changement du chart.

## Licences

Chart et scripts : MIT. n8n : [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/). n8n-mcp : MIT. Projet indépendant, non affilié à n8n GmbH.
