/**
 * The workspace resolver: membership resolution behind a directory port.
 *
 * `createWorkspaceResolver` orchestrates the (user, workspace-slug) resolution: an active
 * workspace lookup, an UNCONDITIONAL active-membership lookup, a throttled fire-and-forget
 * lastSeen touch, and the entity-grant read that produces the context's entity dimension. All
 * I/O goes through the `TenancyDirectory` port; the package never opens a connection, never sees
 * a model, and never maps refusals to a transport error; that is the composition layer's job.
 *
 * Two contract clauses are load-bearing and pinned by tests:
 *
 * 1. ENUMERATION RESISTANCE. The membership lookup runs even when the workspace lookup missed,
 *    with `NULL_WORKSPACE_ID` standing in for the missing workspace id, so the two refusal causes
 *    stay indistinguishable in query count and timing. The discriminated refusal reason exists
 *    for the composition layer only; the composition MUST map both reasons to one identical
 *    not-found response (same message, same code). The directory must treat the sentinel as an
 *    ordinary query value; special-casing it to skip the read would reopen the timing oracle.
 *
 * 2. GRANTS NARROW, NEVER WIDEN. Zero grant rows resolve to "all" (the absence of narrowing);
 *    one or more rows narrow the context to exactly those entities. The port contract requires
 *    `listEntityGrants` NOT to run through workspace-scoped enforcement: the read happens while
 *    the context is still being built, so an enforced read would fail closed on the very context
 *    it is constructing (hosts typically use a native-driver read with both keys explicit).
 *
 * `userId` arrives well-formed by contract: the composition layer validates and converts raw
 * input BEFORE invoking the resolver; the package performs no id validation.
 *
 * @module core/resolver
 */

import { getTenantContext } from './context.js';
import { configuredLogger } from './config.js';

/**
 * The default throttle window for the lastSeen touch: within it, repeated resolutions write
 * nothing.
 */
export const LAST_SEEN_WRITE_WINDOW_MS = 5 * 60 * 1000;

const NULL_WORKSPACE_HEX = '000000000000000000000000';

/**
 * The null-sentinel workspace id passed to `findActiveMembership` when the workspace lookup
 * misses (the enumeration-resistance device). It is a real, well-formed 24-hex id value (the
 * all-zero ObjectId), so a directory can feed it into an ordinary indexed equality that matches
 * nothing.
 *
 * @type {import('./types.js').ObjectIdLike}
 */
export const NULL_WORKSPACE_ID = Object.freeze({
    toHexString: () => NULL_WORKSPACE_HEX,
    toString: () => NULL_WORKSPACE_HEX,
    /** @param {unknown} other */
    equals: (other) => String(other) === NULL_WORKSPACE_HEX
});

/**
 * Build a resolver over a directory port.
 *
 * @param {import('./resolver.js').WorkspaceResolverDeps} deps
 * @returns {import('./resolver.js').WorkspaceResolver}
 */
export function createWorkspaceResolver(deps) {
    const directory = deps.directory;
    const windowMs = deps.lastSeenWriteWindowMs ?? LAST_SEEN_WRITE_WINDOW_MS;

    /**
     * The throttled, fire-and-forget lastSeen touch. Suppressed entirely under an ambient system
     * context (system flows must leave no presence trace); throttled by the write window;
     * failures are logged through the logger port and never surface to the caller; presence
     * bookkeeping must never block or fail a resolution.
     *
     * @param {import('./resolver.js').DirectoryMembership} membership
     * @returns {void}
     */
    function maybeRecordLastSeen(membership) {
        const record = directory.recordLastSeen;
        if (record === undefined) return;
        if (getTenantContext()?.kind === 'system') return;
        const staleBefore = new Date(Date.now() - windowMs);
        if (membership.lastSeenAt != null && membership.lastSeenAt >= staleBefore) {
            return;
        }
        void Promise.resolve()
            .then(() => record.call(directory, membership._id, staleBefore))
            .catch((/** @type {unknown} */ error) => {
                const logger = deps.logger ?? configuredLogger();
                if (logger) {
                    logger.log('error', 'membership lastSeenAt write failed', {
                        membershipId: String(membership._id),
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error)
                    });
                }
            });
    }

    return async function resolveWorkspace(params) {
        const workspace = await directory.findActiveWorkspaceBySlug(
            params.workspaceSlug
        );
        const membership = await directory.findActiveMembership(
            params.userId,
            workspace ? workspace._id : NULL_WORKSPACE_ID
        );

        if (!workspace) return { ok: false, reason: 'workspace' };
        if (!membership) return { ok: false, reason: 'membership' };

        maybeRecordLastSeen(membership);

        const grants = await directory.listEntityGrants(
            workspace._id,
            membership._id
        );
        /** @type {import('./types.js').ObjectIdLike[] | 'all'} */
        const entityIds = grants.length === 0 ? 'all' : [...grants];

        return {
            ok: true,
            context: {
                kind: 'workspace',
                userId: params.userId,
                workspaceId: workspace._id,
                slug: params.workspaceSlug,
                accessRole: membership.accessRole,
                entityIds,
                invited: membership.invitationId != null
            }
        };
    };
}
