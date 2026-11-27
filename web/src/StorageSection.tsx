import { lazy, Suspense } from "react";
import type { StorageView } from "./storageSunburst";

const StorageSunburst = lazy(() => import("./StorageSunburst").then((module) => ({ default: module.StorageSunburst })));

export function StorageSection({ view, update }: {
  view: StorageView;
  update: (patch: Partial<Omit<StorageView, "node">>) => void;
}) {
  return (
    <section className="status-section" aria-labelledby="status-storage-title">
      <div className="status-section-head"><div><h2 id="status-storage-title">Storage</h2><p>Storage, read and write pressure{view.node ? ` on ${view.node}` : ""}.</p></div></div>
      <Suspense fallback={<p className="status-message" role="status">Loading storage data…</p>}>
        <StorageSunburst view={view} update={update} />
      </Suspense>
    </section>
  );
}
