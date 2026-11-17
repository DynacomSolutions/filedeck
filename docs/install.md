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
| `apiToken.secretName` | Existing Secret holding the read-only token for `filedeck du` (empty = feature off) |
| `vault.*` | Saved-password vault: key Secret, volume size and class, entry lifetime. `vault.keyJob` creates the key before the hub starts; check vault health after installation |
| `hub.nodeSelector` | Pin the hub (its vault volume is ReadWriteOnce) |
| `hub.affinity`, `hub.tolerations` | Hub scheduling; the chart adds a required pod affinity so a rolling update keeps both hubs on one node |
| `hub.strategy` | Hub rollout, default `RollingUpdate` (surge 1, unavailable 0); `Recreate` stops the old hub first |
| `sources[]` | Network sources (SFTP, WebDAV, S3, SMB) and the Secrets holding their credentials |
| `brand` | `name`, `title`, `icon`, `css` and `themeKey`; `cssContent` is chart-only (neutral "Filedeck" when empty) |
| `mapping.enabled`, `mapping.host` | Optional Emissary / Ambassador Mapping to the hub; with another ingress route to the `filedeck` Service yourself |
| `testSources.*` | Scratch SFTP, WebDAV, S3 and SMB servers for trying the sources (off; needs SealedSecret ciphertext in `testSources.sealed`) |

Agents run as root with the node's `/` mounted read-write, and there are no user accounts: keep the hub on a trusted network and leave the agent NetworkPolicy in place. Anything that can reach the hub can use it, so on a shared cluster also set `agentToken.generate: true` and `hub.networkPolicy` (the chart default allows any pod to reach the hub, so that a plain install works behind any ingress). Each agent is selected by the label `app.kubernetes.io/instance: <release>-agent-<name>`.

## Vault storage

> **Warning:** the vault volume holds a SQLite file shared briefly by two hub pods during a rollout. It must be block or local storage (ReadWriteOnce); never back it with NFS or SMB.

[Back to the README](../README.md)
