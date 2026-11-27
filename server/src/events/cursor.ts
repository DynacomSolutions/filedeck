/**
 * A cursor names one place in one agent's event journal: `<node>:<epoch>:<seq>`. The epoch changes when the journal is lost or started over
 * (its sequence numbers then mean nothing to a client that holds an older epoch). The node name may hold ":", so a cursor is read from the right.
 */
export interface Cursor {
  node: string;
  epoch: string;
  seq: number;
}

export const formatCursor = (node: string, epoch: string, seq: number): string => `${node}:${epoch}:${seq}`;

export function parseCursor(s: string): Cursor | null {
  if (s.length > 300) return null;
  const b = s.lastIndexOf(":");
  const a = b > 0 ? s.lastIndexOf(":", b - 1) : -1;
  if (a <= 0) return null;
  const seq = s.slice(b + 1);
  const epoch = s.slice(a + 1, b);
  if (!/^\d{1,15}$/.test(seq) || !/^[0-9a-z]{1,16}$/.test(epoch)) return null;
  return { node: s.slice(0, a), epoch, seq: Number(seq) };
}
