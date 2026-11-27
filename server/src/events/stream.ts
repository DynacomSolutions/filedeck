import type { Subscriber } from "./bus.ts";

/** An NDJSON response body for a subscriber: it ends when the stream is over, and the subscriber is released when the client goes away. */
export function subscriberBody(sub: Subscriber, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const done = () => sub.close();
  signal?.addEventListener("abort", done, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      async pull(ctl) {
        const batch = await sub.next();
        if (!batch) {
          signal?.removeEventListener("abort", done);
          sub.close();
          ctl.close();
          return;
        }
        // one chunk per batch: the lines were encoded once for everybody, this joins the references
        ctl.enqueue(batch.length === 1 ? batch[0]! : Buffer.concat(batch));
      },
      cancel() {
        done();
      },
    },
    { highWaterMark: 0 },
  );
}

