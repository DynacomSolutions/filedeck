{{/* Return static nodes only. Runtime reconciliation adds trusted Kubernetes members. */}}
{{- define "filedeck.managedNodes" -}}
{{- toYaml .Values.nodes -}}
{{- end }}
