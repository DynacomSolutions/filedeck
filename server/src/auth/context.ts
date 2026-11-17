import { AsyncLocalStorage } from "node:async_hooks";
import type { Identity } from "./identity.ts";

/**
 * The person behind the request being handled. The gate (and the API token) run the rest of the request inside
 * `runAs`, so code deeper down, such as the hub's calls to agents, can read it with `currentUser()`.
 */
export const userContext = new AsyncLocalStorage<Identity>();

export function currentUser(): Identity | undefined {
  return userContext.getStore();
}

export function runAs<T>(id: Identity, fn: () => T): T {
  return userContext.run(id, fn);
}
