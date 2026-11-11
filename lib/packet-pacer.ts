// Refill a bounded byte budget in batches instead of sleeping for each packet.
// Browsers clamp nested timers to ~4 ms: one 16 KiB packet per timer would
// accidentally cap the stream near 4 MiB/s. Never accumulate more than one
// batch after a disk/network stall. DataChannel backpressure remains separate.
export class PacketPacer {
  private at: number | null = null;
  private credit: number;
  constructor(private bytesPerSecond = 32 * 1048576, private burstBytes = 128 * 1024) {
    this.credit = burstBytes;
  }
  delay(bytes: number, now: number, enabled = true): number {
    if (!enabled) { this.at = null; this.credit = this.burstBytes; return 0; }
    const perMs = this.bytesPerSecond / 1000;
    this.credit = Math.min(this.burstBytes, this.credit + Math.max(0, now - (this.at ?? now)) * perMs);
    this.at = now;
    if (this.credit >= bytes) { this.credit -= bytes; return 0; }
    // Reserve this packet from the next batch. The caller awaits this delay
    // before sending it; there is exactly one send pump per connection.
    const wait = (this.burstBytes - this.credit) / perMs;
    this.at = now + wait;
    this.credit = this.burstBytes - bytes;
    return wait;
  }
}
