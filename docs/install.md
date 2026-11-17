# Install with Helm

Download the chart archive attached to the [latest GitHub release](https://github.com/DynacomSolutions/filedeck/releases), then install it without overrides to try the default configuration:

```sh
helm install filedeck ./filedeck-0.3.39.tgz -n filedeck --create-namespace
kubectl -n filedeck port-forward svc/filedeck 8080:80   # then open http://127.0.0.1:8080
```

Each published release also moves the `stable` git tag to the released commit, so Argo CD deployments can track `targetRevision: stable`.

The defaults give one agent (`local`, any node) that browses the node's filesystem. Values you will most likely set (all documented in `k8s/values.yaml`):

| Value | Meaning |
|---|---|
| `image.repository`, `image.tag`, `image.digest` | The image; a `digest` wins over `tag` |
| `nodes[]` | One agent each: `name` (shown in the UI) and `nodeName` (Kubernetes node; empty = any) |
| `agent.stagger` | Under Argo CD, roll agents one at a time (agent N in sync wave N+1, in `nodes` order); default on, ignored by plain Helm |
| `agent.readOnlyPaths` | Virtual paths no agent may change (default `/proc`, `/sys`) |
| `agentToken.secretName`, `agentToken.generate` | Shared hub-to-agent token: name an existing Secret, or set `generate: true` and a hook Job creates a random one (never rotated); empty and off = none |
| `hub.networkPolicy.enabled`, `hub.networkPolicy.from` | Optional NetworkPolicy for the hub: only the listed peers (for example your ingress controller) may connect; off by default |
| `auth.enabled`, `auth.workers.*`, `auth.agentMemoryLimit` | Sign-in; off by default and not ready to turn on yet (see below) |
| `apiToken.secretName` | Existing Secret holding the read-only token for `filedeck du` (empty = feature off) |
| `vault.*` | Saved-password vault: key Secret, volume size and class, entry lifetime. `vault.keyJob` creates the key before the hub starts; check vault health after installation |
| `hub.nodeSelector` | Pin the hub (its vault volume is ReadWriteOnce) |
| `hub.affinity`, `hub.tolerations` | Hub scheduling; the chart adds a required pod affinity so a rolling update keeps both hubs on one node |
| `hub.strategy` | Hub rollout, default `RollingUpdate` (surge 1, unavailable 0); `Recreate` stops the old hub first |
| `sources[]` | Network sources (SFTP, WebDAV, S3, SMB) and the Secrets holding their credentials |
| `brand` | `name`, `title`, `icon`, `css` and `themeKey`; `cssContent` is chart-only (neutral "Filedeck" when empty) |
| `mapping.enabled`, `mapping.host` | Optional Emissary / Ambassador Mapping to the hub; with another ingress route to the `filedeck` Service yourself |
| `testSources.*` | Scratch SFTP, WebDAV, S3 and SMB servers for trying the sources (off; needs SealedSecret ciphertext in `testSources.sealed`) |

By default (sign-in off) agents run as root with the node's `/` mounted read-write, and there are no user accounts: keep the hub on a trusted network and leave the agent NetworkPolicy in place. Anything that can reach the hub can use it, so on a shared cluster also set `agentToken.generate: true` and `hub.networkPolicy` (the chart default allows any pod to reach the hub, so that a plain install works behind any ingress). Each agent is selected by the label `app.kubernetes.io/instance: <release>-agent-<name>`.

## Turning sign-in on

Sign-in is not ready to turn on yet: system accounts cannot sign in, and there is no screen to make accounts (see [Sign-in and sessions](security.md#sign-in-and-sessions)). When it is, `auth.enabled: true` sets `FILEDECK_AUTH=on` on the hub and on every agent. It needs the agent token: set `agentToken.secretName` or `agentToken.generate: true`, or the chart refuses to render with `auth.enabled needs agentToken`. With sign-in on, each agent runs every signed-in request in a worker process as that person's own user (`auth.workers.max`, default 6 at once; `auth.workers.idleSeconds`, default 600), and each worker has a heap of up to 96 MiB. So the agent's memory limit rises from 512Mi to 1Gi (`auth.agentMemoryLimit`, which replaces `agent.resources.limits.memory`), and the agent container gets the `SYS_CHROOT` capability, which it uses only to run its account lookup helper inside the node's root (`/host`), with the node's own libc and NSS; the helper is run from the image, and nothing is written on the node. Virtual accounts need Landlock ABI 3 or newer on the node (Linux 6.2); the agent logs at start whether it has it. Keep the thumbnail and index folders as the chart sets them (see [Configuration](configuration.md)): pointing them at a shared folder such as `/tmp` makes every worker start fail. With sign-in off, none of this is rendered.

## Vault storage

> **Warning:** the vault volume holds a SQLite file shared briefly by two hub pods during a rollout. It must be block or local storage (ReadWriteOnce); never back it with NFS or SMB.

[Back to the README](../README.md)
