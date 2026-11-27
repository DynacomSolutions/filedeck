import useSWR from "swr";
import { BACKGROUND_HEADER } from "./api";

async function fetchGroups(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: BACKGROUND_HEADER });
  if (response.status === 404 || (response.ok && !response.headers.get("content-type")?.includes("application/json"))) return undefined;
  if (!response.ok) throw new Error(`Storage data is unavailable (HTTP ${response.status}).`);
  return response.json();
}

/** Chart mount point. Replace the body when the groups response and sunburst component are available. */
export function StorageSection({ node }: { node: string | null }) {
  const { data, error, isLoading } = useSWR("/api/groups", fetchGroups, { shouldRetryOnError: false });
  return (
    <section className="status-section" aria-labelledby="status-storage-title">
      <div className="status-section-head"><div><h2 id="status-storage-title">Storage</h2><p>Storage, read and write pressure{node ? ` on ${node}` : ""}.</p></div></div>
      <p className="status-message" role="status">{isLoading ? "Loading storage data…" : error ? String(error.message) :
        data === undefined ? "This hub does not provide grouped storage data yet." : "The storage charts are not available in this version."}</p>
    </section>
  );
}
