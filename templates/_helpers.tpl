{{/*
  Helpers communs au chart n8n-onyxia.
*/}}

{{/* Nom complet (truncate à 63 char pour respecter les labels K8s) */}}
{{- define "n8n.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* Nom du chart pour les labels */}}
{{- define "n8n.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels communs (tous les objets) */}}
{{- define "n8n.labels" -}}
helm.sh/chart: {{ include "n8n.chart" . }}
{{ include "n8n.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: onyxia
{{- end -}}

{{/* Labels sélecteur (immuables — figés à l'install) */}}
{{- define "n8n.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
  Clé de chiffrement n8n — stabilité critique :
    1. Si l'utilisateur a fourni une valeur explicite → on l'utilise.
    2. Sinon, si un Secret existe déjà dans le cluster → on réutilise sa valeur.
    3. Sinon (premier déploiement) → on génère une clé aléatoire 48 char.
  Cela évite la regénération à chaque helm upgrade, qui casserait tous les credentials.
*/}}
{{- define "n8n.encryptionKey" -}}
{{- if .Values.n8n.encryptionKey -}}
{{- .Values.n8n.encryptionKey -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (include "n8n.fullname" .)) -}}
{{- if and $existing $existing.data (index $existing.data "encryptionKey") -}}
{{- index $existing.data "encryptionKey" | b64dec -}}
{{- else -}}
{{- randAlphaNum 48 -}}
{{- end -}}
{{- end -}}
{{- end -}}
