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

# ─── 6. Attendre le Job de provisioning ──────────────────────────────────────
log "Attente du Job de provisioning (création clé API automatique)..."
JOB_NAME="n8n-provisioning"
TIMEOUT_SEC=180
ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT_SEC ]]; do
  STATUS=$(kubectl -n "$NS" get job "$JOB_NAME" -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || echo "")
  if [[ "$STATUS" == "True" ]]; then
    ok "Job de provisioning terminé"
    break
  fi
  # Le Job a pu être déjà supprimé (hook-succeeded delete policy) → on vérifie la clé directement.
  KEY=$(kubectl -n "$NS" get secret n8n -o jsonpath='{.data.N8N_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if [[ ${#KEY} -gt 20 ]]; then
    ok "Clé API n8n présente dans le Secret (longueur ${#KEY})"
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done
if [[ $ELAPSED -ge $TIMEOUT_SEC ]]; then
  warn "Timeout attente Job. La clé API peut être absente — vérifier les logs : kubectl logs -l app.kubernetes.io/component=provisioner"
fi

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
