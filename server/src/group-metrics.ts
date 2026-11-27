export class GroupMetrics {
  requests = 0;
  errors = 0;
  lastSuccess = 0;

  constructor(private readonly name: "groups" | "group_io") {}

  lines(): string[] {
    const prefix = `filedeck_${this.name}`;
    return [
      `# HELP ${prefix}_requests_total Number of requests`,
      `# TYPE ${prefix}_requests_total counter`,
      `${prefix}_requests_total ${this.requests}`,
      `# HELP ${prefix}_errors_total Number of failed or incomplete requests`,
      `# TYPE ${prefix}_errors_total counter`,
      `${prefix}_errors_total ${this.errors}`,
      `# HELP ${prefix}_last_success_timestamp_seconds Unix time of the last successful request, or 0`,
      `# TYPE ${prefix}_last_success_timestamp_seconds gauge`,
      `${prefix}_last_success_timestamp_seconds ${this.lastSuccess / 1000}`,
    ];
  }
}
