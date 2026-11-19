/**
 * In-memory state of the call signaling server (one API instance).
 *
 * What lives here: the open signaling connections of this instance, which user each belongs to,
 * per-call timers (ringing, connecting, reconnect grace, maximum length) and the per-user call
 * start counters. Everything about a call itself (who may answer, its status, which two
 * connections are bound to it) is in MongoDB (CallSession), so a decision never depends on
 * this memory alone.
 *
 * Several API instances would need: a shared presence registry and a pub/sub channel (e.g.
 * Redis) so `toUser`/`toConn` can reach a connection held by another instance, timers owned by
 * one instance (or the database sweeper alone), and a shared start counter. The interface below
 * is the seam for that; see docs/VOICE_CALLS.md.
 */

export interface CallEvent {
  type: string;
  [key: string]: unknown;
}

export interface SignalingConnection {
  /** Opaque, unguessable id given to the client after it authenticates. */
  id: string;
  schoolId: string;
  userId: string;
  send(event: CallEvent): void;
  close(code: number, reason: string): void;
  /**
   * A server-side participant (the AI agent of an AI call), not a device: it never makes its
   * user look online, and the per-user connection limit never closes it.
   */
  virtual?: boolean;
  /**
   * A connection opened only for live updates (new notifications and messages), by a user who
   * may not use calls. It never receives call events or signals, is never bound to a call and
   * never makes its user reachable for calls.
   */
  eventsOnly?: boolean;
  /** The device acknowledges each incoming call at once (client feature "acks"). */
  acks?: boolean;
}

const userKey = (schoolId: string, userId: string) => `${schoolId}:${userId}`;

class CallHub {
  private conns = new Map<string, SignalingConnection>();
  private byUser = new Map<string, Set<string>>();

  add(conn: SignalingConnection) {
    this.conns.set(conn.id, conn);
    const k = userKey(conn.schoolId, conn.userId);
    const set = this.byUser.get(k) ?? new Set<string>();
    set.add(conn.id);
    this.byUser.set(k, set);
  }

  remove(id: string) {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    const k = userKey(conn.schoolId, conn.userId);
    const set = this.byUser.get(k);
    set?.delete(id);
    if (set && !set.size) this.byUser.delete(k);
  }

  get(id: string | undefined | null): SignalingConnection | undefined {
    return id ? this.conns.get(id) : undefined;
  }

  /** The connection, only if it belongs to exactly this user of this school. */
  owned(id: string | undefined | null, schoolId: string, userId: string): SignalingConnection | undefined {
    const c = this.get(id);
    return c && !c.eventsOnly && c.schoolId === schoolId && c.userId === userId ? c : undefined;
  }

  isOnline(schoolId: string, userId: string) {
    for (const id of this.byUser.get(userKey(schoolId, userId)) ?? []) {
      const c = this.conns.get(id);
      if (c && !c.virtual && !c.eventsOnly) return true;
    }
    return false;
  }

  toUser(schoolId: string, userId: string, event: CallEvent, exceptConnId?: string) {
    for (const id of this.byUser.get(userKey(schoolId, userId)) ?? []) {
      const c = this.conns.get(id);
      if (id !== exceptConnId && c && !c.eventsOnly) c.send(event);
    }
  }

  /**
   * A live update for every open device of a user (calls connections included): "something new
   * arrived, fetch it". It carries no private content; the client reads the record through the
   * API with the usual permission checks.
   */
  toUserDevices(schoolId: string, userId: string, event: CallEvent) {
    for (const id of this.byUser.get(userKey(schoolId, userId)) ?? []) {
      const c = this.conns.get(id);
      if (c && !c.virtual) c.send(event);
    }
  }

  /** Every call-capable connection of a user, for events that differ per device. */
  connsOf(schoolId: string, userId: string, opts: { includeEventsOnly?: boolean } = {}): SignalingConnection[] {
    return [...(this.byUser.get(userKey(schoolId, userId)) ?? [])].flatMap((id) => {
      const c = this.conns.get(id);
      return c && (opts.includeEventsOnly || !c.eventsOnly) ? [c] : [];
    });
  }

  toConn(id: string | undefined | null, event: CallEvent): boolean {
    const c = this.get(id);
    if (!c || c.eventsOnly) return false;
    c.send(event);
    return true;
  }

  /** Close every connection of a user (signed out, disabled). */
  disconnectUser(schoolId: string, userId: string, code: number, reason: string) {
    for (const id of [...(this.byUser.get(userKey(schoolId, userId)) ?? [])]) this.conns.get(id)?.close(code, reason);
  }

  /** Shutdown: clients reconnect to the next instance and rejoin their calls. */
  closeAll(code: number, reason: string) {
    for (const c of [...this.conns.values()]) c.close(code, reason);
  }

  get size() {
    return this.conns.size;
  }

  /** Tests only. */
  reset() {
    this.conns.clear();
    this.byUser.clear();
  }
}

export const callHub = new CallHub();

/** Per-call timers. Clearing one call's timers never touches another call. */
class CallTimers {
  private timers = new Map<string, Map<string, NodeJS.Timeout>>();

  set(callId: string, name: string, ms: number, fn: () => void) {
    this.clear(callId, name);
    const t = setTimeout(() => {
      this.timers.get(callId)?.delete(name);
      fn();
    }, ms);
    t.unref();
    const m = this.timers.get(callId) ?? new Map<string, NodeJS.Timeout>();
    m.set(name, t);
    this.timers.set(callId, m);
  }

  clear(callId: string, name?: string) {
    const m = this.timers.get(callId);
    if (!m) return;
    for (const [n, t] of m) {
      if (name && n !== name) continue;
      clearTimeout(t);
      m.delete(n);
    }
    if (!m.size) this.timers.delete(callId);
  }

  has(callId: string, name: string) {
    return Boolean(this.timers.get(callId)?.has(name));
  }

  clearAll() {
    for (const id of [...this.timers.keys()]) this.clear(id);
  }
}

export const callTimers = new CallTimers();

/** Sliding one-minute window of call starts per user. */
class StartCounter {
  private starts = new Map<string, number[]>();

  /** Records a start and reports whether the user is still within `limit` per minute. */
  take(schoolId: string, userId: string, limit: number, now = Date.now()) {
    const k = userKey(schoolId, userId);
    const recent = (this.starts.get(k) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      this.starts.set(k, recent);
      return false;
    }
    recent.push(now);
    this.starts.set(k, recent);
    return true;
  }

  reset() {
    this.starts.clear();
  }
}

export const callStarts = new StartCounter();
