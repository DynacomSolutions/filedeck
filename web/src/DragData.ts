export const DRAG_MIME = "application/x-filedeck";
export interface DragPayload {
  node: string;
  paths: string[];
}
export function setDrag(e: React.DragEvent, p: DragPayload) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(p));
  e.dataTransfer.effectAllowed = "copyMove";
}
export function getDrag(e: React.DragEvent): DragPayload | null {
  const raw = e.dataTransfer.getData(DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}
export const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
