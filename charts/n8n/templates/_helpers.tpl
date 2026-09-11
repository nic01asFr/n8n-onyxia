{{/*
  Helpers du chart n8n. Noms et labels viennent de la library-chart Onyxia
  (library-chart.fullname, library-chart.labels, library-chart.selectorLabels).
*/}}

{{/* Hôte public de l'éditeur n8n (ingress ou route OpenShift). */}}
{{- define "n8n.hostname" -}}
{{- if .Values.ingress.enabled -}}
{{- .Values.ingress.hostname -}}
{{- else if .Values.route.enabled -}}
{{- .Values.route.hostname -}}
{{- end -}}
{{- end -}}

{{/* URL publique de l'éditeur, terminée par « / ». */}}
{{- define "n8n.baseUrl" -}}
{{- $scheme := ternary "https" "http" (or .Values.route.enabled .Values.ingress.tls) -}}
{{- printf "%s://%s/" $scheme (include "n8n.hostname" .) -}}
{{- end -}}

{{/* Secret existant de la release, s'il y en a un (vide en helm template). */}}
{{- define "n8n.existingSecretData" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "library-chart.fullname" .) -}}
{{- if and $existing $existing.data -}}
{{- toJson $existing.data -}}
{{- else -}}
{{- "{}" -}}
{{- end -}}
{{- end -}}

{{/*
  Mot de passe owner effectif.
    1. valeur fournie (Onyxia : {{service.oneTimePassword}}) ;
    2. sinon valeur déjà présente dans le Secret (mises à jour) ;
    3. sinon tirage aléatoire.
  n8n refuse un mot de passe sans majuscule ni chiffre, or celui d'Onyxia est en
  base 36 minuscule : on préfixe alors « N8n- ». La transformation est
  idempotente, le résultat reste stable d'une mise à jour à l'autre.
*/}}
{{- define "n8n.ownerPassword" -}}
{{- if not (hasKey .Values "__ownerPassword") -}}
{{- $existing := include "n8n.existingSecretData" . | fromJson -}}
{{- $password := .Values.security.password -}}
{{- if not $password -}}
{{- $password = (index $existing "OWNER_PASSWORD" | default (index $existing "ownerPassword") | default "" | b64dec) | default (randAlphaNum 24) -}}
{{- end -}}
{{- if not (and (regexMatch "[A-Z]" $password) (regexMatch "[0-9]" $password) (ge (len $password) 8)) -}}
{{- $password = printf "N8n-%s" $password | trunc 64 -}}
{{- end -}}
{{/* Mémorisé : un tirage aléatoire doit valoir la même chose dans le Secret et dans les notes. */}}
{{- $_ := set .Values "__ownerPassword" $password -}}
{{- end -}}
{{- index .Values "__ownerPassword" -}}
{{- end -}}

{{/*
  Clé de chiffrement n8n : valeur fournie, sinon Secret existant, sinon tirage.
  Les charts 0.x la rangeaient sous « encryptionKey » : la reprendre évite, lors
  d'une mise à jour, de tirer une clé neuve qui rendrait les credentials
  illisibles.
*/}}
{{- define "n8n.encryptionKey" -}}
{{- if not (hasKey .Values "__encryptionKey") -}}
{{- $existing := include "n8n.existingSecretData" . | fromJson -}}
{{- $stored := index $existing "N8N_ENCRYPTION_KEY" | default (index $existing "encryptionKey") | default "" | b64dec -}}
{{- $key := .Values.n8n.encryptionKey | default $stored | default (randAlphaNum 48) -}}
{{- $_ := set .Values "__encryptionKey" $key -}}
{{- end -}}
{{- index .Values "__encryptionKey" -}}
{{- end -}}

{{/*
  Jeton Bearer du serveur MCP : valeur fournie, sinon dérivé du mot de passe
  owner. Dérivé plutôt que tiré au sort : il reste stable sans lookup et les
  notes peuvent l'afficher, sans que sa lecture révèle le mot de passe.
*/}}
{{- define "n8n.mcpToken" -}}
{{- .Values.mcp.token | default (printf "%s:n8n-mcp" (include "n8n.ownerPassword" .) | sha256sum | trunc 48) -}}
{{- end -}}

{{/*
  Source PostgreSQL retenue :
    « external »  : database.type = postgresdb ;
    « discovery » : discovery.postgresql et un service PostgreSQL Onyxia trouvé ;
    vide          : SQLite.
*/}}
{{- define "n8n.postgresMode" -}}
{{- if eq .Values.database.type "postgresdb" -}}
external
{{- else if and .Values.discovery.postgresql (first (include "library-chart.getOnyxiaDiscoverySecrets" (list .Release.Namespace "postgres") | fromJsonArray)) -}}
discovery
{{- end -}}
{{- end -}}

{{/* Nom du Secret de la release. */}}
{{- define "n8n.secretName" -}}
{{- include "library-chart.fullname" . -}}
{{- end -}}

{{/*
  Clé API partagée entre le provisioning et le MCP, relative à la racine du
  volume : montée en /home/node/.n8n côté n8n, en /n8n-data côté MCP.
*/}}
{{- define "n8n.apiKeyRelPath" -}}
onyxia/n8n-api-key
{{- end -}}
