/**
 * ActivityProgressReporter — batches progress deltas per `progressKey`
 * and flushes them to the server on well-defined boundaries.
 *
 * Flush triggers (in order of preference)
 *   1. Explicit `flush(reason)` call — used at end-of-game / end-of-level
 *      (the "natural" boundary the player just crossed).
 *   2. 60-second wall-clock tick — safety net for long endless runs so
 *      progress doesn't sit uploaded in RAM indefinitely.
 *
 * Idempotency
 *   Each flush emits ONE POST per progressKey with a fresh clientTxnId.
 *   On network failure the same batch (same clientTxnId + same delta)
 *   is retried on the next tick — the server returns duplicate=true if
 *   the first attempt actually landed, so we can safely clear pending
 *   in either case.
 *
 * Usage
 *   // Hook into GameState / GameController wherever the event fires:
 *   ActivityProgressReporter.report('lines_cleared_total', linesJustCleared);
 *
 *   // End of run:
 *   await ActivityProgressReporter.flush('game-over');
 *
 * The reporter self-installs a 60s tick on first `report()` call, so
 * no explicit init is required. Tick auto-stops when the reporter has
 * no pending or in-flight batches for 3 consecutive ticks.
 */

import { reportActivityProgress, ProgressReportResult, PlayerActivityStatus } from './ActivityApi';

// ---------------------------------------------------------------------------
//  UUID v4 generator — 36 chars, matches server regex /^[A-Za-z0-9-]{8,64}$/
// ---------------------------------------------------------------------------
function uuidV4(): string {
    // Prefer the platform crypto if available (secure), fall back to
    // Math.random. Correctness only requires uniqueness within a
    // player's txn history — Math.random is fine for that.
    const g: any = (typeof globalThis !== 'undefined' ? globalThis : {}) as any;
    if (g?.crypto?.randomUUID) return g.crypto.randomUUID();
    const bytes = new Array<number>(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    // RFC 4122 v4 bits
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

// ---------------------------------------------------------------------------
//  State
// ---------------------------------------------------------------------------

/** A batch waiting to be flushed for one progressKey. `clientTxnId` is
 *  assigned when the batch is first flushed — retries reuse the SAME
 *  id so the server's dedup fires. */
interface PendingBatch {
    delta:       number;
    clientTxnId: string | null;
    inFlight:    boolean;
}

const TICK_MS = 60_000;
const IDLE_STOP_TICKS = 3;

type StatusListener = (items: PlayerActivityStatus[], reason: string) => void;

class Reporter {
    private pending = new Map<string, PendingBatch>();
    private tickHandle: any = null;
    private idleTicks = 0;
    private listeners = new Set<StatusListener>();

    /** Add `delta` to the pending batch for `progressKey`. Starts the
     *  60s tick on first call. `delta` MUST be a positive integer;
     *  fractional / zero / negative values are ignored (with a warn). */
    report(progressKey: string, delta: number): void {
        if (!Number.isInteger(delta) || delta < 1) {
            if (delta !== 0) console.warn(`[Activity] report ignored — bad delta ${delta}`);
            return;
        }
        const cur = this.pending.get(progressKey);
        if (cur) {
            cur.delta += delta;
        } else {
            this.pending.set(progressKey, { delta, clientTxnId: null, inFlight: false });
        }
        this.idleTicks = 0;
        this.ensureTick();
    }

    /** Flush every non-empty non-in-flight batch to the server. Await
     *  the returned promise if you want the latest server state before
     *  proceeding (e.g. showing the activity panel post-game). */
    async flush(reason: string = 'manual'): Promise<void> {
        const jobs: Promise<void>[] = [];
        for (const [key, batch] of this.pending) {
            if (batch.inFlight || batch.delta < 1) continue;
            jobs.push(this.flushOne(key, batch, reason));
        }
        await Promise.all(jobs);
    }

    /** Subscribe to server-confirmed progress updates. Fires ONCE per
     *  successful batch response with the affected activities' new
     *  status. Panel controllers use this to repaint without polling. */
    subscribe(fn: StatusListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    /** Drop every pending / in-flight batch WITHOUT sending. Used on
     *  sign-out — pending progress belongs to the previous account. */
    reset(): void {
        this.pending.clear();
        this.stopTick();
        this.idleTicks = 0;
    }

    // ------------------------------------------------------------------
    private ensureTick(): void {
        if (this.tickHandle) return;
        this.tickHandle = setInterval(() => this.onTick(), TICK_MS);
    }

    private stopTick(): void {
        if (!this.tickHandle) return;
        clearInterval(this.tickHandle);
        this.tickHandle = null;
    }

    private onTick(): void {
        const anyPending = Array.from(this.pending.values()).some(b => b.delta > 0 || b.inFlight);
        if (!anyPending) {
            this.idleTicks++;
            if (this.idleTicks >= IDLE_STOP_TICKS) this.stopTick();
            return;
        }
        this.idleTicks = 0;
        // Fire-and-forget — flush() catches per-batch errors internally.
        void this.flush('tick');
    }

    private async flushOne(key: string, batch: PendingBatch, reason: string): Promise<void> {
        batch.inFlight = true;
        if (!batch.clientTxnId) batch.clientTxnId = uuidV4();
        const sendDelta = batch.delta;
        const txnId     = batch.clientTxnId;
        try {
            // 1..500 clamp — the server enforces the same range; anything
            // over 500 in one batch gets split into 500-sized chunks.
            const capped = Math.min(500, sendDelta);
            const result: ProgressReportResult = await reportActivityProgress(key, capped, txnId);
            // Success (or duplicate) — clear the flushed portion. If we
            // capped, keep the remainder in the batch under a NEW txnId.
            const remainder = sendDelta - capped;
            batch.delta = remainder;
            batch.clientTxnId = remainder > 0 ? uuidV4() : null;
            batch.inFlight = false;
            this.notify(result.items, reason);
        } catch (err: any) {
            batch.inFlight = false;
            // Keep the batch (delta + clientTxnId) untouched — next tick
            // will retry with the same txnId so the server dedups.
            console.warn(`[Activity] flush "${key}" failed:`, err?.message || err);
        }
    }

    private notify(items: PlayerActivityStatus[], reason: string): void {
        for (const fn of this.listeners) {
            try { fn(items, reason); } catch (e) { console.warn('[Activity] listener threw', e); }
        }
    }
}

export const ActivityProgressReporter = new Reporter();

/** Standard progressKey constants — keep the string in one place so
 *  a typo in a game-event handler doesn't silently miss all activities.
 *  Add new keys here as new activity types ship. */
export const ActivityProgressKeys = {
    LINES_CLEARED_TOTAL: 'lines_cleared_total',
} as const;
