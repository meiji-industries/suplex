export class GithubTriggerPoller {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  constructor(private readonly pass: () => Promise<void>, private readonly onError: (error: unknown) => void = () => {}) {}
  start(): void { if (this.running) return; this.running = true; this.run(); }
  async stop(): Promise<void> { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; await this.inFlight; }
  private run(): void { if (!this.running || this.inFlight) return; this.inFlight = this.pass().catch(error => this.onError(error)).finally(() => { this.inFlight = undefined; if (this.running) this.timer = setTimeout(() => this.run(), 60_000); }); }
}
