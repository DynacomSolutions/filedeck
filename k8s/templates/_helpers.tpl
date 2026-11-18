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
       (an agent per node, a scratch server per kind): `dict "root" $ "instance" "<release>-agent-<node>"`.
       `chartLabel` is optional and is used only where a pod template needs a stable upgrade label. */}}
{{- define "filedeck.instanceLabels" -}}
app.kubernetes.io/name: {{ include "filedeck.name" .root }}
app.kubernetes.io/instance: {{ .instance }}
app.kubernetes.io/part-of: filedeck
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- if .chartLabel }}
helm.sh/chart: {{ .chartLabel }}
{{- else }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version | replace "+" "_" }}
{{- end }}
{{- end -}}

{{- define "filedeck.agentName" -}}
{{- printf "filedeck-agent-%s" .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "filedeck.agentInstance" -}}
{{- printf "%s-agent-%s" .root.Release.Name .node.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- /* Name of the shared hub-to-agent Secret: the configured one, else the generated one, else empty (no token). */}}
{{- define "filedeck.agentTokenSecret" -}}
{{- if .Values.agentToken.secretName -}}
{{- .Values.agentToken.secretName -}}
{{- else if .Values.agentToken.generate -}}
{{- printf "%s-agent-token" (include "filedeck.name" .) -}}
{{- end -}}
{{- end -}}

{{- /* The Tailscale sign-in settings the chart refuses to render without. */}}
{{- define "filedeck.tailscaleChecks" -}}
{{- $t := .Values.auth.tailscale -}}
{{- $sc := $t.sidecar -}}
{{- if and (or $sc.enabled $t.headers $t.socket) (not .Values.auth.enabled) -}}
{{- fail "auth.tailscale needs auth.enabled" -}}
{{- end -}}
{{- if $sc.enabled -}}
{{- if not $sc.authKey.secretName -}}
{{- fail "auth.tailscale.sidecar needs authKey.secretName" -}}
{{- end -}}
{{- if not $sc.image.repository -}}
{{- fail "auth.tailscale.sidecar needs image.repository" -}}
{{- end -}}
{{- if not (or $sc.image.tag $sc.image.digest) -}}
{{- fail "auth.tailscale.sidecar needs image.tag or image.digest" -}}
{{- end -}}
{{- if lt (int .Values.hub.trustedProxies) 1 -}}
{{- fail "auth.tailscale.sidecar needs hub.trustedProxies of 1 or more (Serve ends TLS and sends X-Forwarded-Proto and X-Forwarded-For)" -}}
{{- end -}}
{{- if or (lt (int $sc.listenPort) 1) (gt (int $sc.listenPort) 65535) (eq (int $sc.listenPort) (int .Values.port)) -}}
{{- fail "auth.tailscale.sidecar.listenPort must be a port from 1 to 65535 and not the hub port" -}}
{{- end -}}
{{- else if and (or $t.headers $t.socket) (not $t.proxies) -}}
{{- fail "auth.tailscale.headers or socket needs proxies" -}}
{{- end -}}
{{- end -}}

{{- /* The socket tailscaled makes in the sidecar; the hub container mounts the same folder. */}}
{{- define "filedeck.tailscaleSocketDir" -}}/var/run/tailscale{{- end -}}

{{- /* FILEDECK_TAILSCALE_LISTEN: the identity listener. With the sidecar it is an address tailscaled never dials (it forwards to 127.0.0.1 and ::1). */}}
{{- define "filedeck.tailscaleListen" -}}
{{- if .Values.auth.tailscale.listen -}}{{ .Values.auth.tailscale.listen }}
{{- else if .Values.auth.tailscale.sidecar.enabled -}}127.0.0.2:{{ .Values.auth.tailscale.sidecar.listenPort }}
{{- end -}}
{{- end -}}

{{- /* FILEDECK_TAILSCALE_PROXIES: the listed proxies, and the loopback entries when the sidecar is on. */}}
{{- define "filedeck.tailscaleProxies" -}}
{{- $l := .Values.auth.tailscale.proxies | default list -}}
{{- if .Values.auth.tailscale.sidecar.enabled -}}
{{- $l = concat (list "127.0.0.1/32" "::1/128") $l -}}
{{- end -}}
{{- join "," ($l | uniq) -}}
{{- end -}}

{{- /* The serve configuration: HTTPS 443 on the device to the hub's port in the same pod. */}}
{{- define "filedeck.tailscaleServe" -}}
{{- dict "TCP" (dict "443" (dict "HTTPS" true)) "Web" (dict "${TS_CERT_DOMAIN}:443" (dict "Handlers" (dict "/" (dict "Proxy" (printf "http://127.0.0.2:%v" (int .Values.auth.tailscale.sidecar.listenPort)))))) | toPrettyJson -}}
{{- end -}}
