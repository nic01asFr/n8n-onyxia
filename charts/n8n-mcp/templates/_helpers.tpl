{{/* Helpers du chart n8n-mcp-onyxia */}}

{{- define "n8n-mcp.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "n8n-mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "n8n-mcp.labels" -}}
helm.sh/chart: {{ include "n8n-mcp.chart" . }}
{{ include "n8n-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: onyxia
{{- end -}}

{{- define "n8n-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
  AUTH_TOKEN MCP — stable entre upgrades :
    1. Si valeur explicite fournie → on l'utilise.
    2. Sinon, si Secret existe déjà → on réutilise.
    3. Sinon → on génère aléatoire 48 char.
*/}}
{{- define "n8n-mcp.authToken" -}}
{{- if .Values.mcpAuth.token -}}
{{- .Values.mcpAuth.token -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Release.Namespace (include "n8n-mcp.fullname" .)) -}}
{{- if and $existing $existing.data (index $existing.data "AUTH_TOKEN") -}}
{{- index $existing.data "AUTH_TOKEN" | b64dec -}}
{{- else -}}
{{- randAlphaNum 48 -}}
{{- end -}}
{{- end -}}
{{- end -}}
