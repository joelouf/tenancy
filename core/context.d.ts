/**
 * Request-scoped tenant context — TypeScript Declarations.
 *
 * @module core/context
 * @version 1.0.0
 */
import type { ObjectIdLike } from './types.js';

/** A normal request acting inside exactly one workspace. */
export interface WorkspaceContext {
    kind: 'workspace';
    userId: ObjectIdLike;
    workspaceId: ObjectIdLike;
    /** The workspace's URL slug. */
    slug: string;
    /**
     * The membership's role, carried verbatim from the directory. Plain string in the package;
     * consumers narrow it to their own role union at the composition boundary.
     */
    accessRole: string;
    /**
     * The entity dimension: the entities this membership may see, resolved from the host's grant
     * rows at context time. "all" is the absence of narrowing rows; a list narrows every
     * entity-owned read and write through the scope plugin. Grants narrow, never widen.
     */
    entityIds: ObjectIdLike[] | 'all';
    /** Whether this membership arrived through an invitation (invitation provenance). */
    invited: boolean;
}

/**
 * The audited escape hatch: migrations and system jobs only. While a system context is active
 * the scope plugin does NOT inject a workspace filter, so code running here can cross
 * workspaces. Every entry is logged through the configured logger port.
 */
export interface SystemContext {
    kind: 'system';
    reason: string;
}

export type TenantContext = WorkspaceContext | SystemContext;

/**
 * Thrown when a workspace-scoped operation runs with no tenant context, or when any enforcement
 * rule refuses an operation. Fail-closed by design. Carries a stable `code` for property-based
 * discrimination across module copies.
 */
export declare class WorkspaceScopeError extends Error {
    readonly code: 'WORKSPACE_SCOPE_ERROR';
    constructor(message: string);
}

export declare function isWorkspaceScopeError(
    err: unknown
): err is WorkspaceScopeError;

export declare function getTenantContext(): TenantContext | undefined;
export declare function requireTenantContext(): TenantContext;
export declare function requireWorkspaceContext(): WorkspaceContext;

declare const workspaceIdBrand: unique symbol;

/**
 * A workspace id that a user id cannot be mistaken for.
 *
 * Both are hex strings, so `updateThing(id, userId, ...)` and `updateThing(id, workspaceId, ...)`
 * are the same call to the compiler. The brand exists only in the type system; at runtime this is
 * the hex string. `requireRowWorkspaceId` and `workspaceIdOf` are the only ways to make one, so
 * anything else needs a visible cast that review and grep can find.
 */
export type WorkspaceId = string & { readonly [workspaceIdBrand]: true };

export declare function requireRowWorkspaceId(
    row: { workspaceId?: { toString(): string } | null },
    entity: string
): WorkspaceId;

export declare function workspaceIdOf(ctx: WorkspaceContext): WorkspaceId;

export declare function requireWorkspaceId(): WorkspaceId;

export declare function runWithWorkspace<T>(
    ctx: Omit<WorkspaceContext, 'kind'>,
    fn: () => Promise<T>
): Promise<T>;

export interface RunAsSystemOptions {
    /**
     * Audit-log level for the bypass line. Default "warn" (migrations/jobs); sanctioned
     * high-frequency sites (provisioning) pass a quieter level.
     */
    level?: 'warn' | 'info' | 'debug';
}

export declare function runAsSystem<T>(
    reason: string,
    fn: () => Promise<T>,
    options?: RunAsSystemOptions
): Promise<T>;
