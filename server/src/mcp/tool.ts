import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { ToolError } from "./hub-call.ts";
import type { McpSession } from "./events.ts";

export interface ReadToolSpec<I extends z.ZodRawShape, O extends z.ZodRawShape> {
  title: string;
  description: string;
  input: I;
  output: O;
}

/**
 * Registers a tool that only reads, when the session's grant names it. The handler returns the structured result. A `ToolError` becomes a result with `isError` (the client sees the
 * message); any other error becomes a plain "internal error" result and is counted. Every call is counted by outcome and timed.
 */
export function readTool<I extends z.ZodRawShape, O extends z.ZodRawShape>(
  server: McpServer,
  session: McpSession,
  name: string,
  spec: ReadToolSpec<I, O>,
  run: (args: z.objectOutputType<I, z.ZodTypeAny>, signal: AbortSignal) => Promise<Record<string, unknown>>,
): void {
  // a tool that the grant does not name does not exist for the session: it is not listed and a call gets the SDK's "not found"
  if (!session.scope.allowsTool(name)) return;
  const { metrics, grant } = session;
  server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      outputSchema: spec.output,
      annotations: { title: spec.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (async (args: never, extra: { signal: AbortSignal }) => {
      const t0 = performance.now();
      try {
        const out = await run(args, extra.signal);
        metrics.toolCall(grant, name, "ok", (performance.now() - t0) / 1000);
        return { content: [{ type: "text" as const, text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        metrics.toolCall(grant, name, "error", (performance.now() - t0) / 1000);
        if (!(e instanceof ToolError)) metrics.error(grant, "internal");
        const message = e instanceof ToolError ? e.message : "internal error";
        return { content: [{ type: "text" as const, text: message }], isError: true };
      }
    }) as never,
  );
}
