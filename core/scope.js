/**
 * The scope-filter algebra: pure builders for the workspace filter and pipeline fragments the
 * enforcement adapter and the host's repository layer apply.
 *
 * Everything here is pure (no ambient reads, no I/O), so the isolation guarantees can be asserted
 * without a database, which is exactly where they are asserted.
 *
 * @module core/scope
 */

/**
 * The filter every workspace-scoped read/update/delete must carry: it pins `workspaceId` to the
 * current context.
 *
 * @param {import('./context.js').WorkspaceContext} ctx
 * @returns {Record<string, unknown>}
 */
export function readScopeFilter(ctx) {
    return { workspaceId: ctx.workspaceId };
}

/**
 * The entity pin a narrowed membership adds on entity-owned reads, or null when the context sees
 * all entities. Null entityIds stay visible: a null is a workspace-level document; the write
 * guards prevent narrowed contexts from minting misleading nulls on models where null is not a
 * real state.
 *
 * @param {import('./context.js').WorkspaceContext} ctx
 * @returns {Record<string, unknown> | null}
 */
export function entityPinFilter(ctx) {
    if (ctx.entityIds === 'all') return null;
    return { entityId: { $in: [null, ...ctx.entityIds] } };
}

/**
 * The `$match` stage that scopes the top of an aggregation pipeline.
 *
 * @param {Record<string, unknown>} filter
 * @returns {{ $match: Record<string, unknown> }}
 */
export function scopeMatchStage(filter) {
    return { $match: { ...filter } };
}

/**
 * True when an existing leading `$match` already enforces the *exact* scope we would inject: the
 * same workspace. A leading `$match` pinning a *different* workspace does not count: we must not
 * trust it (that would let a mis-built pipeline widen scope), so our own guard goes in front of
 * it.
 *
 * @param {Record<string, unknown>} match
 * @param {Record<string, unknown>} filter
 * @returns {boolean}
 */
function matchCoversScope(match, filter) {
    return String(match.workspaceId ?? '') === String(filter.workspaceId ?? '');
}

/**
 * Prepend the workspace scope `$match` to a pipeline in place. Idempotent only when the identical
 * guard already leads: a different or weaker leading `$match` is never trusted; our guard goes
 * in front so the effective scope can only narrow, never widen. A narrowed context passes
 * `alwaysPrepend`: an existing leading `$match` can cover the workspace without covering the
 * entity pin, and prepending twice only narrows.
 *
 * @param {object[]} pipeline
 * @param {Record<string, unknown>} filter
 * @param {{ alwaysPrepend?: boolean }} [options]
 * @returns {void}
 */
export function prependScopeMatch(pipeline, filter, options = {}) {
    if (!options.alwaysPrepend) {
        const first = pipeline[0];
        if (first && typeof first === 'object' && '$match' in first) {
            const leading = /** @type {{ $match: Record<string, unknown> }} */ (
                first
            ).$match;
            if (matchCoversScope(leading, filter)) return;
        }
    }
    pipeline.unshift(scopeMatchStage(filter));
}
