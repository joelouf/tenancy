/**
 * The workspace resolver: TypeScript Declarations.
 *
 * @module core/resolver
 * @version 1.0.0
 */
import type { LoggerPort, ObjectIdLike } from './types.js';
import type { WorkspaceContext } from './context.js';

/** The active workspace row the directory returns: id only; the slug is what was asked. */
export interface DirectoryWorkspace {
    readonly _id: ObjectIdLike;
}

/** The active membership row the directory returns. */
export interface DirectoryMembership {
    readonly _id: ObjectIdLike;
    readonly accessRole: string;
    readonly invitationId?: ObjectIdLike | null;
    readonly lastSeenAt?: Date | null;
}

/**
 * The directory port: the four reads/writes the resolver needs, implemented by the host over
 * its own models.
 *
 * Contract clauses:
 * - `findActiveWorkspaceBySlug` and `findActiveMembership` return only ACTIVE rows; a suspended
 *   or revoked membership is a null, which is what makes revocation next-request-immediate.
 * - `findActiveMembership` receives `NULL_WORKSPACE_ID` when the workspace lookup missed, and
 *   must run its ordinary query against it (enumeration resistance; never special-case it).
 * - `listEntityGrants` must NOT run through workspace-scoped enforcement: it executes while the
 *   context is still being built, so an enforced read would fail closed on the very context it
 *   is constructing. Zero rows mean all-entities; rows narrow, never widen.
 * - `recordLastSeen` is optional; when present it owns the conditional write (only rows still
 *   stale before `staleBefore`) and its own persistence errors are surfaced by rejection, which
 *   the resolver logs and swallows.
 */
export interface TenancyDirectory {
    findActiveWorkspaceBySlug(
        slug: string
    ): Promise<DirectoryWorkspace | null>;
    findActiveMembership(
        userId: ObjectIdLike,
        workspaceId: ObjectIdLike
    ): Promise<DirectoryMembership | null>;
    listEntityGrants(
        workspaceId: ObjectIdLike,
        membershipId: ObjectIdLike
    ): Promise<readonly ObjectIdLike[]>;
    recordLastSeen?(
        membershipId: ObjectIdLike,
        staleBefore: Date
    ): void | Promise<unknown>;
}

export interface WorkspaceResolverDeps {
    readonly directory: TenancyDirectory;
    /** Throttle window for the lastSeen touch; defaults to LAST_SEEN_WRITE_WINDOW_MS. */
    readonly lastSeenWriteWindowMs?: number;
    /** Logger for fire-and-forget failures; defaults to the configured logger port, read late. */
    readonly logger?: LoggerPort;
}

export interface ResolveWorkspaceParams {
    /** Well-formed by contract: the composition validates raw input before calling. */
    readonly userId: ObjectIdLike;
    readonly workspaceSlug: string;
}

/**
 * Why a resolution was refused. For the composition layer ONLY: both reasons MUST map to one
 * identical not-found response (same message, same code), or the refusal becomes an existence
 * oracle for workspace slugs.
 */
export type WorkspaceRefusalReason = 'workspace' | 'membership';

export type WorkspaceResolution =
    | { ok: true; context: WorkspaceContext }
    | { ok: false; reason: WorkspaceRefusalReason };

export type WorkspaceResolver = (
    params: ResolveWorkspaceParams
) => Promise<WorkspaceResolution>;

export declare const LAST_SEEN_WRITE_WINDOW_MS: number;

export declare const NULL_WORKSPACE_ID: ObjectIdLike;

export declare function createWorkspaceResolver(
    deps: WorkspaceResolverDeps
): WorkspaceResolver;
