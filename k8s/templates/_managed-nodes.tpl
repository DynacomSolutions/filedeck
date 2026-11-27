{{/* Return the static nodes plus authorised Kubernetes Linux Nodes. */}}
{{- define "filedeck.managedNodes" -}}
{{- $nodes := deepCopy .Values.nodes -}}
{{- $known := dict -}}
{{- range .Values.nodes }}{{- $_ := set $known .name true -}}{{- end }}
{{- if .Values.managedNodes.enabled }}
{{- $label := default "dynacom.dev/filedeck-managed" .Values.managedNodes.label -}}
{{- $wanted := default "true" .Values.managedNodes.value -}}
{{- range (lookup "v1" "Node" "" "").items }}
{{- $name := .metadata.name -}}
{{- if and (not (hasKey $known $name)) (eq (default "" (index .metadata.labels "kubernetes.io/os")) "linux") (eq (default "" (index .metadata.labels $label)) $wanted) }}
{{- $nodes = append $nodes (dict "name" $name "mode" "kubernetes" "nodeName" $name) -}}
{{- end }}
{{- end }}
{{- end }}
{{- toYaml $nodes -}}
{{- end }}
