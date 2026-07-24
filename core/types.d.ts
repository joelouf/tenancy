/**
 * Shared structural types — TypeScript Declarations.
 *
 * @module core/types
 * @version 1.0.0
 */

/**
 * The structural id shape the engine works with. Any object exposing the ObjectId surface
 * satisfies it — a Mongoose/BSON ObjectId does, and so does a hand-rolled stub in tests. The core
 * never calls `instanceof` on ids and never constructs one; comparisons happen through
 * `String(...)` so hex-equal ids from different libraries agree.
 */
export interface ObjectIdLike {
    toHexString(): string;
    toString(): string;
    equals(other: unknown): boolean;
}

/** The levels the logger port accepts. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * The optional logging seam. The engine is silent by default: when no logger is configured, the
 * system-bypass provenance line and the fire-and-forget lastSeen failure line are dropped, never
 * buffered. Consumers wire this to their structured logger via `configureTenancy`.
 */
export interface LoggerPort {
    log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/**
 * The one configuration record, passed to `configureTenancy`. Keys are merged: a call that
 * provides only `logger` leaves a previously configured `entityOwnedCollections` intact, and vice
 * versa, so independent composition modules may each configure their own concern.
 */
export interface TenancyConfiguration {
    /**
     * Collection names whose documents carry an entityId scope stamp. `scopedLookup` refuses to
     * build any join until this list has been configured (fail closed): an unknown list would
     * silently skip the entity pin, which is a cross-entity widening, not a degraded mode.
     */
    entityOwnedCollections?: readonly string[];
    /** The logger port; omit to leave unchanged, pass null for explicit silence. */
    logger?: LoggerPort | null;
}
