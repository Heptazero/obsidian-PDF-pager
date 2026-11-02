import { createReadingSession, localDayKey } from "./reading-log.ts";
import type { EpubLocation, ReadingSession } from "./reading-state.ts";

/** Counts only foreground time up to the idle deadline; layout events never restart it. */
export class ReadingTracker {
  private session: ReadingSession | null = null;
  private location: EpubLocation | null = null;
  private lastTick = 0;
  private lastActivity = 0;
  private lastSave = 0;
  private pending: Promise<void> = Promise.resolve();
  private active: () => boolean;
  private preferences: () => { idleMs: number; dayEndMinutes: number };
  private save: (session: ReadingSession) => Promise<void>;
  private now: () => number;
  private uid: () => string;

  constructor(
    active: () => boolean,
    preferences: () => { idleMs: number; dayEndMinutes: number },
    save: (session: ReadingSession) => Promise<void>,
    now: () => number = Date.now,
    uid: () => string = () => window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  ) { this.active = active; this.preferences = preferences; this.save = save; this.now = now; this.uid = uid; }

  setLocation(location: EpubLocation): void {
    this.location = { ...location };
    if (this.session) this.session.endLocation = { ...location };
  }

  activity(): void {
    const timestamp = this.now();
    this.tick(timestamp);
    if (!this.active() || !this.location) return;
    if (!this.session) {
      this.begin(timestamp);
      this.lastTick = timestamp;
      this.lastSave = timestamp;
    }
    this.lastActivity = timestamp;
  }

  tick(timestamp = this.now()): void {
    if (!this.session) return;
    const { idleMs, dayEndMinutes } = this.preferences();
    // Timer intervals are short; cap suspended timers so a sleeping device cannot add hours.
    const end = Math.min(timestamp, this.lastActivity + idleMs, this.lastTick + 20_000);
    if (end > this.lastTick && this.session.day !== localDayKey(end, dayEndMinutes)) {
      const boundary = new Date(end);
      boundary.setHours(Math.floor(dayEndMinutes / 60), dayEndMinutes % 60, 0, 0);
      if (boundary.getTime() > end) boundary.setDate(boundary.getDate() - 1);
      const cutoff = Math.max(this.lastTick, boundary.getTime());
      this.session.durationMs += cutoff - this.lastTick;
      this.session.endedAt = cutoff;
      this.session.updatedAt = cutoff;
      this.persist();
      this.begin(cutoff);
      this.lastTick = cutoff;
    }
    const session = this.session;
    if (!session) return;
    if (end > this.lastTick) {
      session.durationMs += end - this.lastTick;
      session.endedAt = end;
      session.updatedAt = timestamp;
    }
    this.lastTick = timestamp;
    if (!this.active() || timestamp >= this.lastActivity + idleMs) {
      this.persist();
      this.session = null;
    } else if (timestamp - this.lastSave >= 30_000) this.persist();
  }

  private begin(timestamp: number): void {
    this.session = createReadingSession(this.uid(), localDayKey(timestamp, this.preferences().dayEndMinutes), timestamp, 1);
    if (this.location) {
      this.session.startLocation = { ...this.location };
      this.session.endLocation = { ...this.location };
    }
  }

  pause(): void {
    this.tick();
    this.persist();
    this.session = null;
  }

  private persist(): void {
    if (!this.session || this.session.durationMs < 5_000) return;
    const snapshot: ReadingSession = {
      ...this.session,
      startLocation: this.session.startLocation ? { ...this.session.startLocation } : undefined,
      endLocation: this.session.endLocation ? { ...this.session.endLocation } : undefined,
    };
    this.lastSave = this.now();
    this.pending = this.pending.catch(() => undefined).then(() => this.save(snapshot));
    // Keep the rejection observable by flush without creating an unhandled timer rejection.
    void this.pending.catch(() => undefined);
  }

  async flush(): Promise<void> {
    this.tick();
    this.persist();
    await this.pending;
  }
}
