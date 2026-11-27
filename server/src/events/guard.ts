/**
 * Whether a path (a query string allowed) the hub would send to an agent could reach the agent's change event stream, read the wide way (as
 * `isAgentAuthPath` does for the sign-in routes): percent escapes decoded, `\` taken as `/`, repeated slashes as one, `.` and `..` resolved, and letters in any
 * case. A path that cannot be read counts as a match, so the check fails closed.
 */
export function isChangesPath(pathAndQuery: string): boolean {
  try {
    const decoded = (pathAndQuery.split("?")[0] ?? "").replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const flat = ("/" + decoded.replace(/\\/g, "/")).replace(/\/{2,}/g, "/");
    return /^\/api\/v1\/changes\/*$/.test(new URL(flat, "http://x").pathname.toLowerCase());
  } catch {
    return true;
  }
}
