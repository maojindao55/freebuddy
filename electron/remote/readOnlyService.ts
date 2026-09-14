import { RelayClient, type RelayClientOptions } from "./relayClient.js";
import { createReadonlyRemoteHost } from "./readonlyHost.js";
import type { HostStatusSource } from "./snapshotService.js";

/** Main-process-only, explicit local enablement point. It starts disabled. */
export class ReadOnlyRemoteService {
  private relay: RelayClient | undefined;
  private detachEvents: (() => void) | undefined;
  private readonly host;
  constructor(private readonly input: { hostId: string; status: () => HostStatusSource }) { this.host = createReadonlyRemoteHost(input); }
  get enabled(): boolean { return !!this.relay; }
  enable(options: Omit<RelayClientOptions, "enabled" | "onFrame">): void {
    if (this.relay) return;
    let relay: RelayClient;
    relay = new RelayClient({ ...options, enabled: true, onFrame: frame => this.host.onFrame(frame, relay) });
    this.relay = relay;
    this.detachEvents = this.host.attachEvents(relay);
    relay.start();
  }
  disable(): void { this.detachEvents?.(); this.detachEvents = undefined; this.relay?.stop(); this.relay = undefined; }
}
