#!/usr/bin/env bash
#
# install.sh — Déploie n8n et son serveur MCP dans le namespace SSPCloud courant.
#
# Usage (depuis un terminal de pod Jupyter SSPCloud lancé en rôle Kubernetes Edit) :
#   curl -sL https://nic01asfr.github.io/n8n-onyxia/install.sh | bash
#
# Ce script fait en ligne de commande ce que fait le formulaire Onyxia : il
# calcule les hôtes publics, génère le mot de passe owner, installe le chart,
# puis enregistre le service dans « Mes services ». Le compte owner et la clé API
# du MCP sont créés par le pod lui-même.
#
# Variables d'env optionnelles :
#   OWNER_EMAIL    : email du compte owner n8n. Sinon git config, sinon demandé.
#   NAMESPACE      : namespace cible. Sinon $KUBERNETES_NAMESPACE ou contexte courant.
#   RELEASE        : nom de la release Helm (défaut : n8n).
#   CHART_VERSION  : version du chart (défaut : la plus récente).
#   SKIP_MCP       : "true" pour installer n8n sans serveur MCP.
#   PORTAL         : "true" pour ajouter le portail d'actions (workflows mis à
#                    disposition dans Grist), "false" pour le retirer. Sans la
#                    variable, une mise à jour garde le réglage en place.
#   MIGRATE        : "true" pour reprendre une release des charts 0.x (n8n 1.x) en
#                    conservant ses données : sauvegarde, puis mise à jour en place.
#   BACKUP_DIR     : dossier de la sauvegarde faite avant migration (défaut : dossier courant).
#   HELM_REPO_URL  : surcharge de l'URL du dépôt Helm (tests).
#   HELM_CONFIG_HOME / HELM_CACHE_HOME / HELM_DATA_HOME : répertoires Helm
#     (défaut /tmp/helm/* : certains pods Jupyter ont /home/onyxia en lecture seule).
#
set -euo pipefail

# --- Affichage -----------------------------------------------------------------
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

# --- 1. Prérequis ----------------------------------------------------------------
log "Vérification des prérequis..."
command -v kubectl >/dev/null || die "kubectl introuvable. Lance ce script dans un service Jupyter SSPCloud."
command -v helm    >/dev/null || die "helm introuvable. Lance ce script dans un service Jupyter SSPCloud."

export HELM_CONFIG_HOME="${HELM_CONFIG_HOME:-/tmp/helm/config}"
export HELM_CACHE_HOME="${HELM_CACHE_HOME:-/tmp/helm/cache}"
export HELM_DATA_HOME="${HELM_DATA_HOME:-/tmp/helm/data}"
mkdir -p "$HELM_CONFIG_HOME" "$HELM_CACHE_HOME" "$HELM_DATA_HOME"

# --- 2. Namespace et droits ------------------------------------------------------
NS="${NAMESPACE:-${KUBERNETES_NAMESPACE:-}}"
if [[ -z "$NS" ]]; then
  NS=$(kubectl config view --minify -o jsonpath='{..namespace}' 2>/dev/null || echo "")
fi
[[ -z "$NS" ]] && die "Impossible de déterminer le namespace. Définir NAMESPACE=user-XXX."
case "$NS" in
  user-*|projet-*) ;;
  *) warn "Namespace '$NS' : ce script vise les namespaces SSPCloud user-* et projet-*." ;;
esac
ok "Namespace cible : ${BOLD}$NS${RESET}"

# Le rôle « Edit » du pod Jupyter est requis : « View » ne peut ni installer ni
# lire les Secrets, dont Helm a besoin pour lister ses releases.
kubectl auth can-i create deployments -n "$NS" >/dev/null 2>&1 \
  || die "Pas le droit de créer des Deployments dans $NS. Relance ton pod Jupyter avec le rôle Kubernetes Edit."
kubectl auth can-i get secrets -n "$NS" >/dev/null 2>&1 \
  || die "Pas le droit de lire les Secrets dans $NS. Relance ton pod Jupyter avec le rôle Kubernetes Edit."

RELEASE="${RELEASE:-n8n}"
DOMAIN="${ONYXIA_DOMAIN:-user.lab.sspcloud.fr}"
N8N_HOST="${NS}-${RELEASE}.${DOMAIN}"
MCP_HOST="${NS}-${RELEASE}-mcp.${DOMAIN}"
PORTAL_HOST="${NS}-${RELEASE}-portail.${DOMAIN}"

# --- 3. Release existante ----------------------------------------------------------
EXISTING_CHART=$(helm list -n "$NS" --filter "^${RELEASE}\$" -o json 2>/dev/null \
  | sed -n 's/.*"chart":"\([^"]*\)".*/\1/p')
SECRET_NAME="$RELEASE"
[[ "$RELEASE" != *n8n* ]] && SECRET_NAME="${RELEASE}-n8n"

MIGRATING=false
if [[ "$EXISTING_CHART" == n8n-0.* ]]; then
  # Les charts 0.x installaient n8n 1.x : passer en 2.x migre la base, sans
  # retour possible autrement que par la sauvegarde. On ne le fait que sur demande.
  [[ "${MIGRATE:-false}" == "true" ]] || die "La release '$RELEASE' utilise le chart $EXISTING_CHART (n8n 1.x).
La mise à jour migre la base vers n8n 2.x, sans retour arrière autre qu'une sauvegarde.
Pour migrer en conservant les données (sauvegarde faite d'abord) :
  curl -sL https://nic01asfr.github.io/n8n-onyxia/install.sh | MIGRATE=true bash"
  MIGRATING=true
  log "Migration de la release '$RELEASE' ($EXISTING_CHART) vers le chart actuel"
elif [[ -n "$EXISTING_CHART" ]] && helm status n8n-mcp -n "$NS" >/dev/null 2>&1; then
  warn "Une ancienne release 'n8n-mcp' existe : le serveur MCP fait désormais partie du chart n8n."
  warn "Pour la retirer : helm uninstall n8n-mcp -n $NS"
fi

# --- 4. Email et mot de passe owner ------------------------------------------------
# Lecture d'une clé du Secret de la release, sous son nom actuel ou sous celui
# des charts 0.x.
secret_value() {
  local key
  for key in "$@"; do
    local value
    value=$(kubectl get secret "$SECRET_NAME" -n "$NS" -o jsonpath="{.data.$key}" 2>/dev/null | base64 -d 2>/dev/null || true)
    [[ -n "$value" ]] && { printf '%s' "$value"; return 0; }
  done
  return 0
}

if [[ -z "${OWNER_EMAIL:-}" ]]; then
  OWNER_EMAIL=$(secret_value OWNER_EMAIL ownerEmail)
fi
if [[ -z "$OWNER_EMAIL" ]]; then
  OWNER_EMAIL=$(git config --global user.email 2>/dev/null || echo "")
fi
if [[ -z "$OWNER_EMAIL" ]] && [[ -r /dev/tty ]]; then
  printf "Email du compte owner n8n : "
  read -r OWNER_EMAIL < /dev/tty
fi
[[ -z "$OWNER_EMAIL" ]] && die "OWNER_EMAIL requis. Définir la variable ou git config --global user.email."
ok "Compte owner : $OWNER_EMAIL"

# Mise à jour ou migration : on repasse le mot de passe déjà en place, pour que
# les notes continuent de l'afficher. Premier déploiement : mot de passe conforme
# à la politique n8n (majuscule et chiffre), comme le ferait Onyxia.
OWNER_PASSWORD=$(secret_value OWNER_PASSWORD ownerPassword)
if [[ -z "$OWNER_PASSWORD" ]]; then
  # « || true » : head ferme le tube, tr reçoit SIGPIPE, et pipefail l'aurait
  # transformé en échec du script.
  OWNER_PASSWORD="N8n-$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 20 || true)"
fi

# --- 5. Installation -----------------------------------------------------------------
HELM_REPO_URL="${HELM_REPO_URL:-https://nic01asfr.github.io/n8n-onyxia}"
log "Dépôt Helm : $HELM_REPO_URL"
helm repo add n8n-onyxia "$HELM_REPO_URL" --force-update >/dev/null
helm repo update n8n-onyxia >/dev/null

HELM_ARGS=(
  --namespace "$NS"
  --set "ingress.hostname=$N8N_HOST"
  --set "ingress.ingressClassName=onyxia"
  --set "mcp.hostname=$MCP_HOST"
  --set "security.email=$OWNER_EMAIL"
  --set "security.password=$OWNER_PASSWORD"
  # Nom de release stable en ligne de commande : garder volume et Secret
  # permet de réinstaller sans perdre les workflows.
  --set "persistence.keepOnUninstall=true"
)
[[ "${SKIP_MCP:-false}" == "true" ]] && HELM_ARGS+=(--set "mcp.enabled=false")
case "${PORTAL:-}" in
  true)  HELM_ARGS+=(--set "portal.enabled=true" --set "portal.hostname=$PORTAL_HOST") ;;
  false) HELM_ARGS+=(--set "portal.enabled=false") ;;
  "")    ;;
  *)     die "PORTAL vaut « true » ou « false », pas « $PORTAL »." ;;
esac
[[ -n "${CHART_VERSION:-}" ]] && HELM_ARGS+=(--version "$CHART_VERSION")

if [[ "$MIGRATING" == "true" ]]; then
  # --- Migration depuis un chart 0.x -------------------------------------------
  # Volume : Kubernetes refuse de réduire un volume ou d'en changer la classe, on
  # reprend donc taille et classe existantes.
  PVC_SIZE=$(kubectl get pvc "$SECRET_NAME" -n "$NS" -o jsonpath='{.spec.resources.requests.storage}')
  PVC_CLASS=$(kubectl get pvc "$SECRET_NAME" -n "$NS" -o jsonpath='{.spec.storageClassName}')
  [[ -n "$PVC_SIZE" ]] || die "Volume '$SECRET_NAME' introuvable : migration impossible sans les données."
  HELM_ARGS+=(--set "persistence.size=$PVC_SIZE")
  [[ -n "$PVC_CLASS" ]] && HELM_ARGS+=(--set "persistence.storageClass=$PVC_CLASS")

  # Données : les charts 0.x les rangeaient dans « .n8n/.n8n » du volume.
  if kubectl exec -n "$NS" "deploy/$SECRET_NAME" -- test -f /home/node/.n8n/.n8n/database.sqlite 2>/dev/null; then
    HELM_ARGS+=(--set "n8n.userFolder=/home/node/.n8n")
  fi

  # Sauvegarde avant toute modification : volume complet et clé de chiffrement.
  BACKUP_DIR="${BACKUP_DIR:-$PWD}"
  STAMP=$(date +%Y%m%d-%H%M%S)
  BACKUP_FILE="$BACKUP_DIR/n8n-backup-$STAMP.tar.gz"
  KEY_FILE="$BACKUP_DIR/n8n-encryption-key-$STAMP.txt"
  log "Sauvegarde du volume dans $BACKUP_FILE ..."
  kubectl exec -n "$NS" "deploy/$SECRET_NAME" -- tar czf - -C /home/node/.n8n . > "$BACKUP_FILE"
  gzip -t "$BACKUP_FILE" || die "Sauvegarde illisible : migration annulée, rien n'a été modifié."
  (umask 077 && secret_value N8N_ENCRYPTION_KEY encryptionKey > "$KEY_FILE")
  [[ -s "$KEY_FILE" ]] || die "Clé de chiffrement introuvable : migration annulée, rien n'a été modifié."
  ok "Sauvegarde faite ($(du -h "$BACKUP_FILE" | cut -f1)), clé dans $KEY_FILE"

  # Étape intermédiaire : n8n ne migre sa base vers 2.x que depuis la dernière
  # 1.x. Éprouvé : un saut direct de 1.80 à 2.38 vide la table shared_workflow,
  # et les workflows perdent leur propriétaire (invisibles, webhooks muets). La
  # release 0.x passe donc d'abord sur la dernière 1.x, avec sa configuration.
  BRIDGE_IMAGE="${N8N_BRIDGE_IMAGE:-docker.n8n.io/n8nio/n8n:1.123.79}"
  CURRENT_TAG=$(kubectl get "deploy/$SECRET_NAME" -n "$NS" -o jsonpath='{.spec.template.spec.containers[?(@.name=="n8n")].image}' | sed 's/.*://')
  if [[ "$CURRENT_TAG" == 1.* ]] && [[ "$(printf '%s\n' "$CURRENT_TAG" "${BRIDGE_IMAGE##*:}" | sort -V | head -1)" == "$CURRENT_TAG" ]] && [[ "$CURRENT_TAG" != "${BRIDGE_IMAGE##*:}" ]]; then
    log "Étape 1/2 : migration de la base avec n8n ${BRIDGE_IMAGE##*:} (depuis $CURRENT_TAG)..."
    # Par Helm plutôt que « kubectl set image » : Helm 4 applique côté serveur et
    # refuserait ensuite de reprendre un champ modifié par un autre gestionnaire.
    helm upgrade "$RELEASE" n8n-onyxia/n8n --namespace "$NS" --version "${EXISTING_CHART#n8n-}" \
      --reuse-values --set "image.repository=${BRIDGE_IMAGE%:*}" --set "image.tag=${BRIDGE_IMAGE##*:}" \
      --wait --timeout 15m >/dev/null \
      || die "n8n ${BRIDGE_IMAGE##*:} ne démarre pas. Données intactes dans $BACKUP_FILE ; journal : kubectl logs deploy/$SECRET_NAME -n $NS"
    ok "Base migrée en n8n ${BRIDGE_IMAGE##*:}"
    log "Étape 2/2 : passage au chart actuel"
  fi

  # Hôtes : le serveur MCP intégré reprend l'hôte de l'ancienne release n8n-mcp,
  # et l'Ingress de l'éditeur change de nom. Deux Ingress sur le même hôte
  # peuvent être refusés par le contrôleur : on libère les hôtes avant.
  if helm status n8n-mcp -n "$NS" >/dev/null 2>&1; then
    helm uninstall n8n-mcp -n "$NS" >/dev/null && ok "Ancienne release n8n-mcp retirée"
    kubectl delete secret n8n-mcp -n "$NS" --ignore-not-found >/dev/null
  fi
  kubectl delete ingress "$SECRET_NAME" -n "$NS" --ignore-not-found >/dev/null
elif [[ -n "$EXISTING_CHART" ]]; then
  # Mise à jour d'une release du chart actuel : on repart des valeurs par défaut
  # du nouveau chart en reprenant celles déjà posées (chemin des données, taille
  # du volume...). Sans cela, une relance remettrait n8n.userFolder à son défaut
  # et n8n repartirait sur une base vide.
  HELM_ARGS+=(--reset-then-reuse-values)
fi

log "Déploiement de n8n sur https://$N8N_HOST ..."
helm upgrade --install "$RELEASE" n8n-onyxia/n8n "${HELM_ARGS[@]}" --wait --timeout 10m >/dev/null
ok "n8n déployé"

# --- 6. Visibilité dans « Mes services » ---------------------------------------------
# Onyxia range les métadonnées d'un service (propriétaire, nom affiché, partage)
# dans un Secret qu'il crée lui-même après une installation depuis le catalogue.
# Le chart ne le crée pas : Onyxia échouerait alors en le recréant. On le pose
# donc ici, et seulement s'il manque.
ONYXIA_SECRET="sh.onyxia.release.v1.${RELEASE}"
if ! kubectl get secret "$ONYXIA_SECRET" -n "$NS" >/dev/null 2>&1; then
  # Projet personnel : le propriétaire est l'idep. Projet de groupe : Onyxia ne
  # montre un service qu'à son propriétaire ou s'il est partagé ; faute de
  # connaître l'idep ici (ONYXIA_IDEP pour le préciser), on le partage au groupe.
  if [[ "$NS" == user-* ]]; then
    OWNER_ID="${NS#user-}"; SHARE="false"
  else
    OWNER_ID="${ONYXIA_IDEP:-}"; SHARE=$([[ -n "$OWNER_ID" ]] && echo "false" || echo "true")
  fi
  kubectl create secret generic "$ONYXIA_SECRET" -n "$NS" --type=onyxia.sh/release.v1 \
    --from-literal=owner="$OWNER_ID" \
    --from-literal=friendlyName="n8n" \
    --from-literal=catalog="n8n-onyxia" \
    --from-literal=share="$SHARE" >/dev/null \
    && ok "Service enregistré pour « Mes services »" \
    || warn "Secret $ONYXIA_SECRET non créé : le service tourne mais peut ne pas apparaître dans Onyxia."
fi

# --- 7. Récapitulatif ------------------------------------------------------------------
echo
helm get notes "$RELEASE" -n "$NS" | sed '1d'
echo
cat <<EOF
${BOLD}Désinstaller${RESET} (volume et Secret sont conservés) :
  helm uninstall $RELEASE -n $NS && kubectl delete secret $ONYXIA_SECRET -n $NS
EOF
