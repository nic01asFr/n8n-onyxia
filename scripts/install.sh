#!/usr/bin/env bash
#
# install.sh — Déploie n8n + n8n-mcp dans le namespace SSPCloud de l'utilisateur.
#
# Usage (depuis un terminal de pod Jupyter SSPCloud) :
#   curl -sL https://nic01asfr.github.io/n8n-onyxia/install.sh | bash
#
# Variables d'env optionnelles :
#   OWNER_EMAIL     : email du compte owner n8n. Sinon dérivé du git config ou prompt.
#   NAMESPACE       : namespace cible. Sinon $KUBERNETES_NAMESPACE ou current context.
#   N8N_VERSION     : version chart n8n (sinon latest)
#   MCP_VERSION     : version chart n8n-mcp (sinon latest)
#   SKIP_MCP        : "true" pour n'installer que n8n
#   HELM_REPO_URL   : surcharger l'URL du Helm repo (debug)
#
set -euo pipefail

# ─── Couleurs ────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

log()  { echo "${CYAN}[--]${RESET} $*"; }
ok()   { echo "${GREEN}[OK]${RESET} $*"; }
warn() { echo "${YELLOW}[!!]${RESET} $*"; }
err()  { echo "${RED}[KO]${RESET} $*" >&2; }
die()  { err "$@"; exit 1; }

# ─── 1. Prérequis ────────────────────────────────────────────────────────────
log "Vérification des prérequis..."
command -v kubectl >/dev/null || die "kubectl introuvable. Lance ce script dans un service Jupyter SSPCloud."
command -v helm    >/dev/null || die "helm introuvable. Lance ce script dans un service Jupyter SSPCloud."

# Vérifier l'accès cluster
if ! kubectl auth can-i get pods >/dev/null 2>&1; then
  die "Pas d'accès au cluster K8s. Le kubeconfig SSPCloud n'est-il pas configuré ?"
fi

# ─── 2. Détection du namespace ───────────────────────────────────────────────
NS="${NAMESPACE:-${KUBERNETES_NAMESPACE:-}}"
if [[ -z "$NS" ]]; then
  NS=$(kubectl config view --minify -o jsonpath='{..namespace}' 2>/dev/null || echo "")
fi
[[ -z "$NS" ]] && die "Impossible de déterminer le namespace. Définir NAMESPACE=user-XXX."

if [[ "$NS" != user-* ]]; then
  warn "Namespace '$NS' ne commence pas par 'user-'. Ce script vise SSPCloud Onyxia."
fi

IDEP="${NS#user-}"
ok "Namespace cible : ${BOLD}$NS${RESET} (idep: $IDEP)"

# ─── 3. Email owner ──────────────────────────────────────────────────────────
if [[ -z "${OWNER_EMAIL:-}" ]]; then
  OWNER_EMAIL=$(git config --global user.email 2>/dev/null || echo "")
fi
if [[ -z "$OWNER_EMAIL" ]] && [[ -t 0 ]]; then
  printf "Email du compte owner n8n : "
  read -r OWNER_EMAIL
fi
[[ -z "$OWNER_EMAIL" ]] && die "OWNER_EMAIL requis. Définir la variable ou git config --global user.email."
ok "Owner email : $OWNER_EMAIL"

# ─── 4. Helm repo ────────────────────────────────────────────────────────────
HELM_REPO_URL="${HELM_REPO_URL:-https://nic01asfr.github.io/n8n-onyxia}"
log "Ajout du Helm repo : $HELM_REPO_URL"
helm repo add nic01asfr "$HELM_REPO_URL" --force-update >/dev/null
helm repo update nic01asfr >/dev/null
ok "Helm repo OK"

# ─── 5. Install n8n ──────────────────────────────────────────────────────────
N8N_HOST="user-${IDEP}-n8n.user.lab.sspcloud.fr"
N8N_RELEASE="n8n"

log "Déploiement de n8n sur https://$N8N_HOST ..."
HELM_ARGS=(
  --namespace "$NS"
  -f "https://nic01asfr.github.io/n8n-onyxia/values-sspcloud.yaml"
  --set "n8n.host=$N8N_HOST"
  --set "owner.email=$OWNER_EMAIL"
)
[[ -n "${N8N_VERSION:-}" ]] && HELM_ARGS+=(--version "$N8N_VERSION")

helm upgrade --install "$N8N_RELEASE" nic01asfr/n8n "${HELM_ARGS[@]}" --wait --timeout 5m
ok "n8n déployé"

# ─── 6. Auto-provisioning côté client (kubectl du user) ──────────────────────
# Pourquoi côté client : SSPCloud refuse create/delete sur Role dans le namespace
# user → un Job in-cluster avec RBAC custom ne passe pas. Le script fait à la place
# le owner-setup + login + create-api-key + patch-Secret depuis ta machine.
#
# Prérequis : curl + jq (installés par défaut dans tous les pods Jupyter SSPCloud).

PROVISION_TIMEOUT="${PROVISION_TIMEOUT:-180}"

provision_n8n_api_key() {
  command -v curl >/dev/null || { warn "curl introuvable, skip provisioning"; return 0; }
  command -v jq   >/dev/null || { warn "jq introuvable, skip provisioning"; return 0; }

  # Skip si la clé existe déjà.
  local existing
  existing=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.N8N_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if [[ ${#existing} -gt 20 ]]; then
    ok "N8N_API_KEY déjà présente (longueur ${#existing}). Skip provisioning."
    return 0
  fi

  log "Attente n8n /healthz public..."
  local n8n_pub="https://$N8N_HOST"
  local i ready=0
  for i in $(seq 1 60); do
    if curl -sf "$n8n_pub/healthz" >/dev/null 2>&1; then
      ready=1; break
    fi
    sleep 3
  done
  if [[ $ready -ne 1 ]]; then
    warn "n8n pas joignable sur $n8n_pub après 3 min. Skip provisioning — la clé API devra être créée manuellement via l'UI."
    return 0
  fi
  ok "n8n joignable"

  # Lire les credentials owner du Secret (créés par le chart).
  local owner_email owner_password owner_first owner_last
  owner_email=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.ownerEmail}' | base64 -d)
  owner_password=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.ownerPassword}' | base64 -d)
  owner_first=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.ownerFirstName}' | base64 -d)
  owner_last=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.ownerLastName}' | base64 -d)

  # Tentative setup owner. 200/201 = succès. 400 = déjà setup (OK on continue).
  log "Setup owner..."
  local setup_http setup_body
  setup_body=$(jq -n --arg e "$owner_email" --arg p "$owner_password" --arg f "$owner_first" --arg l "$owner_last" \
    '{email:$e,firstName:$f,lastName:$l,password:$p}')
  setup_http=$(curl -s -o /tmp/n8n-setup.json -w "%{http_code}" \
    -X POST "$n8n_pub/rest/owner/setup" \
    -H "Content-Type: application/json" \
    -d "$setup_body")
  if [[ "$setup_http" =~ ^20[01]$ ]]; then
    ok "Owner créé"
  else
    log "Setup HTTP $setup_http (probable owner déjà existant)"
  fi

  # Login avec les credentials du Secret.
  # n8n 1.80+ attend "email", versions plus anciennes "emailOrLdapLoginId" — on envoie les deux.
  log "Login..."
  local login_http login_body
  login_body=$(jq -n --arg e "$owner_email" --arg p "$owner_password" \
    '{email:$e,emailOrLdapLoginId:$e,password:$p}')
  login_http=$(curl -s -c /tmp/n8n-cookies.txt -o /tmp/n8n-login.json -w "%{http_code}" \
    -X POST "$n8n_pub/rest/login" \
    -H "Content-Type: application/json" \
    -d "$login_body")
  if [[ "$login_http" != "200" ]]; then
    warn "Login échec HTTP $login_http : $(head -c 200 /tmp/n8n-login.json)"
    warn "Les credentials du Secret ne matchent pas l'owner existant."
    warn "Soit l'owner a été setup via l'UI avec un autre email/password,"
    warn "soit créer la clé manuellement dans l'UI puis :"
    warn "  kubectl -n $NS patch secret n8n --type=merge -p '{\"data\":{\"N8N_API_KEY\":\"<b64 clé>\"}}'"
    return 0
  fi
  ok "Login OK"

  # Création clé API.
  log "Création clé API..."
  local key_body key_resp raw_key
  # expiresAt: null = pas d'expiration (n8n exige le champ explicitement)
  key_body=$(jq -n '{label:"auto-provisioned",expiresAt:null}')
  key_resp=$(curl -s -b /tmp/n8n-cookies.txt \
    -X POST "$n8n_pub/rest/api-keys" \
    -H "Content-Type: application/json" \
    -d "$key_body")
  # Plusieurs formats possibles selon la version n8n.
  raw_key=$(echo "$key_resp" | jq -r '
    .data.rawApiKey // .rawApiKey //
    .data.apiKey // .apiKey //
    .data.key // .key //
    empty
  ' 2>/dev/null)
  if [[ -z "$raw_key" ]] || [[ "$raw_key" == "null" ]]; then
    warn "Échec extraction clé API."
    warn "Réponse n8n (premiers 500 char) : $(echo "$key_resp" | head -c 500)"
    warn "Crée manuellement via UI Settings → API → Create API Key, puis :"
    warn "  KEY=<la clé>"
    warn "  kubectl -n $NS patch secret n8n --type=merge -p \"{\\\"data\\\":{\\\"N8N_API_KEY\\\":\\\"\$(echo -n \$KEY | base64 -w0)\\\"}}\""
    warn "  kubectl -n $NS rollout restart deploy/n8n-mcp"
    return 0
  fi
  ok "Clé API créée (longueur ${#raw_key})"

  # Patch Secret K8s avec la clé.
  local key_b64
  key_b64=$(printf '%s' "$raw_key" | base64 | tr -d '\n')
  kubectl -n "$NS" patch secret n8n --type=merge \
    -p "$(jq -n --arg k "$key_b64" '{data:{N8N_API_KEY:$k}}')" >/dev/null
  ok "Secret n8n patché avec N8N_API_KEY"

  # Si n8n-mcp est déjà déployé, le redémarrer pour qu'il prenne la nouvelle clé.
  # (Les env vars d'un pod ne se rafraîchissent pas tant que le pod n'est pas recréé.)
  if kubectl -n "$NS" get deploy n8n-mcp >/dev/null 2>&1; then
    log "Restart de n8n-mcp pour prise en compte de la nouvelle N8N_API_KEY..."
    kubectl -n "$NS" rollout restart deploy/n8n-mcp >/dev/null
    kubectl -n "$NS" rollout status deploy/n8n-mcp --timeout=60s >/dev/null 2>&1 || warn "Timeout rollout n8n-mcp"
    ok "n8n-mcp redémarré"
  fi

  # Cleanup
  rm -f /tmp/n8n-setup.json /tmp/n8n-login.json /tmp/n8n-cookies.txt
}

provision_n8n_api_key

# ─── 7. Install n8n-mcp (optionnel) ──────────────────────────────────────────
if [[ "${SKIP_MCP:-false}" != "true" ]]; then
  MCP_HOST="user-${IDEP}-n8n-mcp.user.lab.sspcloud.fr"
  MCP_RELEASE="n8n-mcp"
  N8N_API_URL_INTERNAL="http://n8n.${NS}.svc.cluster.local:5678"

  log "Déploiement de n8n-mcp sur https://$MCP_HOST ..."
  MCP_ARGS=(
    --namespace "$NS"
    -f "https://nic01asfr.github.io/n8n-onyxia/values-sspcloud-mcp.yaml"
    --set "mcp.host=$MCP_HOST"
    --set "n8n.apiUrl=$N8N_API_URL_INTERNAL"
  )
  [[ -n "${MCP_VERSION:-}" ]] && MCP_ARGS+=(--version "$MCP_VERSION")

  helm upgrade --install "$MCP_RELEASE" nic01asfr/n8n-mcp "${MCP_ARGS[@]}" --wait --timeout 3m
  ok "n8n-mcp déployé"
fi

# ─── 8. Récap final ──────────────────────────────────────────────────────────
OWNER_PASSWORD=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.ownerPassword}' 2>/dev/null | base64 -d || echo "")
N8N_API_KEY=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.N8N_API_KEY}' 2>/dev/null | base64 -d || echo "")
MCP_AUTH=""
if [[ "${SKIP_MCP:-false}" != "true" ]]; then
  MCP_AUTH=$(kubectl -n "$NS" get secret n8n-mcp -o jsonpath='{.data.AUTH_TOKEN}' 2>/dev/null | base64 -d || echo "")
fi

cat <<EOF

${BOLD}╭──────────────────────────────────────────────────────────────────────╮${RESET}
${BOLD}│  ${GREEN}✓ Déploiement terminé${RESET}${BOLD}                                              │${RESET}
${BOLD}╰──────────────────────────────────────────────────────────────────────╯${RESET}

${BOLD}n8n — UI workflow automation${RESET}
  URL       : ${CYAN}https://$N8N_HOST${RESET}
  Owner     : $OWNER_EMAIL
  Password  : ${YELLOW}$OWNER_PASSWORD${RESET}
  API key   : ${YELLOW}${N8N_API_KEY:0:30}...${N8N_API_KEY: -10}${RESET}

EOF

if [[ -n "$MCP_AUTH" ]]; then
  cat <<EOF
${BOLD}n8n-mcp — Serveur MCP pour LLM${RESET}
  Endpoint  : ${CYAN}https://$MCP_HOST/mcp${RESET}
  Bearer    : ${YELLOW}$MCP_AUTH${RESET}

${BOLD}Connexion Claude Code :${RESET}
  ${GREEN}claude mcp add n8n --transport http https://$MCP_HOST/mcp \\
    --header "Authorization: Bearer $MCP_AUTH"${RESET}

${BOLD}Connexion Claude Desktop (claude_desktop_config.json) :${RESET}
${CYAN}  {
    "mcpServers": {
      "n8n": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "https://$MCP_HOST/mcp",
                 "--header", "Authorization: Bearer $MCP_AUTH"]
      }
    }
  }${RESET}

EOF
fi

cat <<EOF
${BOLD}À sauvegarder absolument${RESET} (récupération impossible si perdu) :
  - ${YELLOW}encryptionKey${RESET} : kubectl -n $NS get secret n8n -o jsonpath='{.data.encryptionKey}' | base64 -d
  - ${YELLOW}ownerPassword${RESET} : kubectl -n $NS get secret n8n -o jsonpath='{.data.ownerPassword}' | base64 -d

EOF
