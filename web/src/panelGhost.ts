/**
 * Drag image for moving a whole panel: a scaled-down snapshot (clone) of the panel element, so the ghost under the cursor is the
 * panel itself and not just the toolbar or handle that was grabbed. Returns a cleanup that removes the temporary clone.
 */
const MAX_W = 320;
const MAX_H = 240;

export function ghostScale(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1;
  return Math.min(1, MAX_W / width, MAX_H / height);
}

export function panelGhost(panel: HTMLElement, e: { dataTransfer: DataTransfer | null }): () => void {
  const dt = e.dataTransfer;
  if (!dt || typeof dt.setDragImage !== "function") return () => undefined;
  const r = panel.getBoundingClientRect();
  const k = ghostScale(r.width, r.height);
  const wrap = document.createElement("div");
  wrap.className = "panel-ghost";
  wrap.setAttribute("aria-hidden", "true");
  Object.assign(wrap.style, { position: "fixed", left: "-10000px", top: "0", width: `${Math.round(r.width * k)}px`, height: `${Math.round(r.height * k)}px` });
  const clone = panel.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-fp");
  clone.removeAttribute("id");
  clone.querySelectorAll("[id],[data-fp]").forEach((n) => (n.removeAttribute("id"), n.removeAttribute("data-fp")));
  Object.assign(clone.style, { width: `${r.width}px`, height: `${r.height}px`, transform: `scale(${k})`, transformOrigin: "0 0", pointerEvents: "none" });
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  dt.setDragImage(wrap, Math.round(24 * k), Math.round(16 * k));
  return () => wrap.remove();
}
