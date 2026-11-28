import fs from "node:fs";

/** The hub address a pod uses when FILEDECK_URL is not set: Service `filedeck` in namespace `dynacom`, port 80. */
export const IN_CLUSTER_URL = "http://filedeck.dynacom.svc";
/** Where a pod mounts the projected ServiceAccount token (audience `filedeck`). */
export const SA_TOKEN_PATH = "/var/run/secrets/filedeck/token";

export const inCluster = (env: NodeJS.ProcessEnv): boolean => !!env.KUBERNETES_SERVICE_HOST;

/** The hub base URL: FILEDECK_URL, else the in-cluster Service in a pod, else nothing. */
export function hubUrl(env: NodeJS.ProcessEnv): string | undefined {
  return (env.FILEDECK_URL || (inCluster(env) ? IN_CLUSTER_URL : undefined))?.replace(/\/+$/, "");
}

/**
 * The token for the next request. Order: FILEDECK_TOKEN, then the file named by FILEDECK_TOKEN_FILE (a mounted secret, read again on each
 * call; an unreadable or empty file gives undefined, it does not fall through). In a pod without either the projected ServiceAccount token is read again on
 * each call, because Kubernetes rotates it. A missing or empty file gives undefined.
 */
export function hubToken(env: NodeJS.ProcessEnv, read: (file: string) => string = (f) => fs.readFileSync(f, "utf8")): string | undefined {
  if (env.FILEDECK_TOKEN) return env.FILEDECK_TOKEN;
  if (env.FILEDECK_TOKEN_FILE) {
    try {
      return read(env.FILEDECK_TOKEN_FILE).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  if (!inCluster(env)) return undefined;
  try {
    return read(env.FILEDECK_SA_TOKEN_FILE || SA_TOKEN_PATH).trim() || undefined;
  } catch {
    return undefined;
  }
}
