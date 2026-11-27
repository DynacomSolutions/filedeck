/** Prometheus text for the MCP server (names start with `filedeck_mcp_`). Served on the hub metrics port. */

const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labelled = (labels: Record<string, string>) => {
  const keys = Object.keys(labels).sort();
  return keys.length ? `{${keys.map((k) => `${k}="${escape(labels[k]!)}"`).join(",")}}` : "";
};

/** Upper bounds of the tool duration histogram, in seconds. */
export const DURATION_BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;

type Labels = Record<string, string>;

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1): void {
    const key = labelled(labels);
    const row = this.values.get(key);
    if (row) row.value += by;
    else this.values.set(key, { labels, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelled(labels))?.value ?? 0;
  }
  lines(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) out.push(`${this.name} 0`);
    for (const [key, row] of [...this.values].sort(([a], [b]) => (a < b ? -1 : 1))) out.push(`${this.name}${key} ${row.value}`);
    return out;
  }
}

export class McpMetrics {
  private readonly sessionsOpened = new Counter("filedeck_mcp_sessions_opened_total", "MCP sessions opened, by grant");
  private readonly sessionsClosed = new Counter("filedeck_mcp_sessions_closed_total", "MCP sessions closed, by grant and reason");
  private readonly notifications = new Counter("filedeck_mcp_notifications_total", "Notifications sent to clients, by grant and kind");
  private readonly toolCalls = new Counter("filedeck_mcp_tool_calls_total", "Tool calls, by grant, tool and outcome");
  private readonly errors = new Counter("filedeck_mcp_errors_total", "Errors, by grant and kind (auth, protocol, internal, notify, watch)");
  private readonly requests = new Counter("filedeck_mcp_http_requests_total", "HTTP requests to the MCP listener, by grant and outcome. The grant is none before a token matched");
  private readonly polls = new Counter("filedeck_mcp_watch_polls_total", "Polls of an agent by the shared node watch, by source and outcome");
  private readonly duration = new Map<string, { buckets: number[]; sum: number; count: number }>();
  /** gauges are read when the text is made */
  gauges: { sessions: () => Map<string, number>; subscriptions: () => Map<string, number>; inflight: () => number; draining: () => boolean; watches: () => number; grants: () => string[] } = {
    sessions: () => new Map(),
    subscriptions: () => new Map(),
    grants: () => [],
    inflight: () => 0,
    draining: () => false,
    watches: () => 0,
  };

  sessionOpened(grant: string): void {
    this.sessionsOpened.inc({ grant });
  }
  sessionClosed(grant: string, reason: string): void {
    this.sessionsClosed.inc({ grant, reason });
  }
  notification(grant: string, kind: "resource_updated" | "list_changed"): void {
    this.notifications.inc({ grant, kind });
  }
  error(grant: string, kind: "auth" | "protocol" | "internal" | "notify" | "watch"): void {
    this.errors.inc({ grant, kind });
  }
  request(grant: string, outcome: string): void {
    this.requests.inc({ grant, outcome });
  }
  poll(source: string, outcome: "ok" | "error"): void {
    this.polls.inc({ source, outcome });
  }
  toolCall(grant: string, tool: string, outcome: "ok" | "error", seconds: number): void {
    this.toolCalls.inc({ grant, tool, outcome });
    const key = `${grant}\n${tool}`;
    let h = this.duration.get(key);
    if (!h) this.duration.set(key, (h = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 }));
    DURATION_BUCKETS.forEach((le, i) => {
      if (seconds <= le) h!.buckets[i]!++;
    });
    h.sum += seconds;
    h.count++;
  }

  lines(): string[] {
    const g = (name: string, help: string, value: number) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`];
    const byGrant = (name: string, help: string, values: Map<string, number>) => {
      const out = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
      const ids = [...new Set([...this.gauges.grants(), ...values.keys()])].sort();
      if (!ids.length) out.push(`${name}{grant="none"} 0`);
      for (const id of ids) out.push(`${name}${labelled({ grant: id })} ${values.get(id) ?? 0}`);
      return out;
    };
    const out = [
      ...byGrant("filedeck_mcp_sessions", "Open MCP sessions, by grant", this.gauges.sessions()),
      ...byGrant("filedeck_mcp_subscriptions", "Resource subscriptions held by open sessions, by grant", this.gauges.subscriptions()),
      ...g("filedeck_mcp_grants", "Grants that are active now", this.gauges.grants().length),
      ...g("filedeck_mcp_inflight_requests", "MCP requests being answered now", this.gauges.inflight()),
      ...g("filedeck_mcp_watched_nodes", "Sources (nodes and the hub job queue) with a running shared watch", this.gauges.watches()),
      ...g("filedeck_mcp_draining", "1 while the MCP server drains for a shutdown", this.gauges.draining() ? 1 : 0),
      ...this.sessionsOpened.lines(),
      ...this.sessionsClosed.lines(),
      ...this.notifications.lines(),
      ...this.toolCalls.lines(),
      ...this.errors.lines(),
      ...this.requests.lines(),
      ...this.polls.lines(),
      "# HELP filedeck_mcp_tool_duration_seconds Tool call duration",
      "# TYPE filedeck_mcp_tool_duration_seconds histogram",
    ];
    for (const [key, h] of [...this.duration].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const [grant, tool] = key.split("\n") as [string, string];
      DURATION_BUCKETS.forEach((le, i) => out.push(`filedeck_mcp_tool_duration_seconds_bucket${labelled({ grant, tool, le: String(le) })} ${h.buckets[i]}`));
      out.push(`filedeck_mcp_tool_duration_seconds_bucket${labelled({ grant, tool, le: "+Inf" })} ${h.count}`);
      out.push(`filedeck_mcp_tool_duration_seconds_sum${labelled({ grant, tool })} ${h.sum}`);
      out.push(`filedeck_mcp_tool_duration_seconds_count${labelled({ grant, tool })} ${h.count}`);
    }
    return out;
  }
}
