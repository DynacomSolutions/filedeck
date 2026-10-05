{{- define "filedeck.name" -}}
{{- default .Chart.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "filedeck.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "filedeck.labels" -}}
{{- include "filedeck.instanceLabels" (dict "root" . "instance" .Release.Name) -}}
{{- end -}}

{{- /* The common labels with app.kubernetes.io/instance set explicitly, for objects selected one by one
       (an agent per node, a scratch server per kind): `dict "root" $ "instance" "<release>-agent-<node>"`. */}}
{{- define "filedeck.instanceLabels" -}}
app.kubernetes.io/name: {{ include "filedeck.name" .root }}
app.kubernetes.io/instance: {{ .instance }}
app.kubernetes.io/part-of: filedeck
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "filedeck.agentName" -}}
{{- printf "filedeck-agent-%s" .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "filedeck.agentInstance" -}}
{{- printf "%s-agent-%s" .root.Release.Name .node.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
