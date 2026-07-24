/**
 * Request-scoped tenant context: the fail-closed gate every scoped operation reads.
 *
 * The enforcement adapter reads the *current* workspace from here, so a workspace-scoped query
 * can never run without an established context. The context is carried on Node's
 * AsyncLocalStorage, which propagates across `await` boundaries within a single async execution.
 *
 * IMPORTANT (Next.js and friends): context set in middleware does NOT propagate into route
 * handlers, server actions, or RSC render; they are separate executions. The context must be
 * established at each server entry point, and queries must be *executed* inside
 * `runWithWorkspace(...)`, not merely built there. This module requires the Node.js runtime
 * (node:async_hooks), never edge.
 *
 * The storage itself lives on `globalThis[Symbol.for('@joelouf/tenancy/context-storage')]`, not
 * in module scope: bundlers duplicate modules (per-route server bundles, symlinked installs), and
 * a per-copy AsyncLocalStorage would mean a context set through one copy is invisible to a query
 * hook captured from another: a total fail-closed outage. `Symbol.for` is process-wide within a
 * realm, so every same-realm copy shares the one store.
 *
 * @module core/context
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { configuredLogger } from './config.js';

const CONTEXT_STORAGE_KEY = Symbol.for('@joelouf/tenancy/context-storage');

const stash = /** @type {{ [key: symbol]: unknown }} */ (
    /** @type {unknown} */ (globalThis)
);

const storage =
    /** @type {AsyncLocalStorage<import('./context.js').TenantContext>} */ (
        stash[CONTEXT_STORAGE_KEY] ??= new AsyncLocalStorage()
    );

/**
 * Thrown when a workspace-scoped operation runs with no tenant context, or when any enforcement
 * rule refuses an operation. This is the fail-closed signal: better a refused query than a leaked
 * one. The class carries a stable machine-readable `code` so compositions that end up with two
 * copies of this module can still discriminate by property rather than class identity.
 */
export class WorkspaceScopeError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = 'WorkspaceScopeError';
        this.code = 'WORKSPACE_SCOPE_ERROR';
    }
}

/**
 * Narrow an unknown value to a WorkspaceScopeError.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export const isWorkspaceScopeError = (err) => err instanceof WorkspaceScopeError;

/**
 * The current context, or `undefined` if none is established.
 *
 * @returns {import('./context.js').TenantContext | undefined}
 */
export function getTenantContext() {
    return storage.getStore();
}

/**
 * The current context, or throw (fail-closed). The scope plugin calls this; a missing context
 * must stop the query, never silently widen it.
 *
 * @returns {import('./context.js').TenantContext}
 */
export function requireTenantContext() {
    const ctx = storage.getStore();
    if (!ctx) {
        throw new WorkspaceScopeError(
            'No tenant context: refusing to run a workspace-scoped operation. ' +
                'Wrap the call in runWithWorkspace() (entry point) or runAsSystem() (migration/job).' // scope-guard-allow: runAsSystem mentioned in error message text, not a call site
        );
    }
    return ctx;
}

/**
 * The current workspace context, or throw if absent or system.
 *
 * @returns {import('./context.js').WorkspaceContext}
 */
export function requireWorkspaceContext() {
    const ctx = requireTenantContext();
    if (ctx.kind !== 'workspace') {
        throw new WorkspaceScopeError(
            'A workspace context is required here, but the current context is `system`.'
        );
    }
    return ctx;
}

/**
 * The workspace a loaded row belongs to, for use as an explicit filter scope.
 *
 * Tenant schemas declare `workspaceId` required, so every domain row has one, but host
 * interfaces often type it optional. That gap is dangerous precisely where it looks harmless:
 * threading `row.workspaceId` straight into a filter can hand the driver `undefined`, which it
 * strips, leaving a query with no workspace scope at all. On a path reached under a system
 * context the scope plugin injects nothing either, so what began as one row's update becomes
 * every matching row in the database.
 *
 * Structurally typed rather than taking a concrete ObjectId class so a lean row, a hydrated
 * document, or a projection all satisfy it.
 *
 * @param {{ workspaceId?: { toString(): string } | null }} row
 * @param {string} entity
 * @returns {import('./context.js').WorkspaceId}
 */
export function requireRowWorkspaceId(row, entity) {
    const workspaceId = row.workspaceId;
    if (!workspaceId) {
        throw new WorkspaceScopeError(
            `${entity} has no workspaceId, so no scope can be derived from it. Refusing to build an unscoped filter.`
        );
    }
    return /** @type {import('./context.js').WorkspaceId} */ (
        workspaceId.toString()
    );
}

/**
 * The workspace of an established request context, as a branded id.
 *
 * @param {import('./context.js').WorkspaceContext} ctx
 * @returns {import('./context.js').WorkspaceId}
 */
export function workspaceIdOf(ctx) {
    return /** @type {import('./context.js').WorkspaceId} */ (
        ctx.workspaceId.toString()
    );
}

/**
 * The current request's workspace, or throw if absent or system.
 *
 * @returns {import('./context.js').WorkspaceId}
 */
export function requireWorkspaceId() {
    return workspaceIdOf(requireWorkspaceContext());
}

/**
 * Run `fn` with a workspace context active.
 *
 * @template T
 * @param {Omit<import('./context.js').WorkspaceContext, 'kind'>} ctx
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithWorkspace(ctx, fn) {
    return storage.run({ kind: 'workspace', ...ctx }, fn);
}

/**
 * Run `fn` with the audited system bypass active (no workspace filter). Use ONLY for migrations
 * and cross-cutting maintenance. Every entry is logged through the configured logger port at the
 * caller-chosen level; the message is the literal provenance line consumers alert on.
 *
 * @template T
 * @param {string} reason
 * @param {() => Promise<T>} fn
 * @param {import('./context.js').RunAsSystemOptions} [options]
 * @returns {Promise<T>}
 */
// scope-guard-allow: runAsSystem this is the audited definition site, not a call site
export function runAsSystem(reason, fn, options = {}) {
    const level = options.level ?? 'warn';
    const logger = configuredLogger();
    if (logger) {
        logger.log(level, 'tenant scope bypass (system context)', { reason });
    }
    return storage.run({ kind: 'system', reason }, fn);
}
