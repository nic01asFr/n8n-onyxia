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

Le Secret de la release contient `N8N_ENCRYPTION_KEY`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `MCP_AUTH_TOKEN` et, portail activé, `PORTAL_WEBHOOK_SECRET` (secret joint aux webhooks, à ne pas changer : le credential n8n du portail le porte). Une valeur vide est tirée au sort une fois, puis relue dans le Secret aux mises à jour (`lookup`). La clé de chiffrement est à sauvegarder : sans elle, les credentials sont illisibles.

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

- **Seule porte vers les workflows.** Le portail appelle les webhooks sur localhost avec l'en-tête `X-Portail-Secret`. Le credential n8n « Portail d'actions (en-tête) », créé par le portail, l'exige : un appel direct au webhook, qui reste joignable par l'hôte de l'éditeur, est refusé, et le contexte `_portail` ne peut pas être forgé. Ce credential ne peut pas servir à un nœud HTTP Request.
- **Identité vérifiée.** Chaque appel porte le jeton `getAccessToken` du lecteur. Le portail le présente à Grist (hôtes de `portal.gristOrigins` uniquement) et ne lit l'utilisateur et le document dans ce jeton que si Grist l'accepte. Le visiteur anonyme d'un document public est reconnu (identifiant découvert par `/api/session/access/active`) : par défaut, il ne voit ni ne lance rien.
- **Droits dans le service.** Les actions exposées, les documents qui les ouvrent et le compte propriétaire sont dans `onyxia/portail.json` sur le volume. Un éditeur du document ne peut rien s'y ouvrir.
- **Connexion à n8n.** Pour fonctionner, le portail est connecté à n8n comme le serveur MCP : par la clé API créée au démarrage, sans rien demander. Pour ouvrir le mode « Configurer », le propriétaire prouve qu'il tient ce n8n avec le compte du service (email, mot de passe, code de double authentification s'il y en a), vérifié par n8n sur `/rest/login` puis refermé, ou avec une clé API. Seuls le propriétaire et les administrateurs de l'instance passent. Il en reste une session d'une heure liée au compte Grist ; rien n'est conservé. Le premier compte Grist connecté qui s'identifie devient propriétaire du portail.
- **Entrées contrôlées côté serveur.** Seuls les champs déclarés passent, convertis et bornés. Le workflow reçoit les entrées à plat (`$json.body.<champ>`) et le contexte sous `$json.body._portail` : `runId`, `action`, `requester.gristUserId`, `document.docId`.
- **Accès au document, par action** (aucun, lecture, écriture). Le widget demande un jeton propre au lancement ; le portail vérifie qu'il appartient au même lecteur et au même document, puis le transmet sous `$json.body._portail.grist` : `baseUrl`, `token`, `access` (`read` si le lecteur n'a que la lecture), `expiresAt` (quelques minutes). Le workflow l'utilise ainsi : `{{ $json.body._portail.grist.baseUrl }}/tables/Table1/records?auth={{ $json.body._portail.grist.token }}`.
- **Résultat dans le document, par action** : `writeBack: { tableId, fields: { cléDuRésultat: colonne } }`. C'est le widget qui écrit, avec les droits du lecteur ; le portail n'écrit jamais dans Grist.
- **Déclencheur accepté** : Webhook en POST, sans paramètre de chemin, protégé par le credential du portail, workflow publié.

Code : [files/portal/](files/portal/). Tests : `node --test tests/portal/*.test.mjs`. Aperçu local sans Grist ni n8n : `node tests/portal/dev-server.mjs`.

## Sécurité du pod

Jusqu'à quatre conteneurs en uid 1000, sans capacité Linux, sans escalade de privilèges, profil seccomp `RuntimeDefault`, sans jeton de ServiceAccount monté. L'image n8n-mcp déclare un utilisateur non numérique : elle tourne elle aussi en uid 1000, avec sa base de nœuds sur un volume temporaire (`NODE_DB_PATH`).
