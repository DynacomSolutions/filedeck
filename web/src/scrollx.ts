import type { WheelEvent } from "react";
/** Fixed-height rows (toolbars, paths) scroll sideways when they do not fit: let the mouse wheel do it. */
export const wheelX = (e: WheelEvent<HTMLElement>) => {
  if (!e.deltaX && e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
};
