/**
 * The Mongoose enforcement adapter — the wall itself.
 *
 * Two schema plugins and the sanctioned join builder. `tenantFieldsPlugin` declares the tenancy
 * paths (workspaceId always; a nullable entityId when the model is entity-owned);
 * `workspaceScopePlugin` enforces the wall on every query middleware, aggregation, validate-time
 * stamp, and insertMany. `scopedLookup` is the ONLY sanctioned way to join collections in an
 * aggregation.
 *
 * mongoose is an OPTIONAL peer dependency imported only in this subpath — importing the package
 * root or core never loads it. The adapter never opens a connection; connection management is
 * entirely the consumer's.
 *
 * Version pins (verified on mongoose 9.6.3, re-verify on upgrade):
 * - Hooks are Mongoose-9 throw-style: no `next` callback anywhere.
 * - mquery's where-merge silently DROPS an `$in` entity pin when the caller's filter already
 *   carries a bare `entityId` equality, so the plugin composes an explicit `$and` via
 *   `setQuery` instead of trusting `where()` merging.
 * - Pipeline (array-form) updates require `{ updatePipeline: true }` in Mongoose 9; the plugin
 *   detects the array form and rejects it under a workspace context.
 * - `pre('insertMany')` receives the docs array as its first argument.
 * - `pre('validate')` stamping runs before `required: true` evaluation, so an auto-populated
 *   workspaceId passes the required check.
 *
 * Coverage gaps (document-level middleware cannot see these; the layer below is DB-level
 * $jsonSchema validators, which consumers should install):
 * - `Model.bulkWrite` does not fire query middleware.
 * - `estimatedDocumentCount` bypasses filters by definition.
 * - Native `.collection.*` access bypasses Mongoose entirely (the resolver's grant read uses
 *   exactly that bypass deliberately, on the host side).
 *
 * Ownership metadata is attached to the schema object itself under
 * `Symbol.for('@joelouf/tenancy/ownership')` rather than kept in a module-level registry: the
 * schema instance is one shared object, so even if the two plugins resolve from different copies
 * of this module, the writer and the reader agree — the split-registry fail-open (entity
 * narrowing silently evaporating) dies by construction.
 *
 * @module adapters/mongoose
 */

import { Schema } from 'mongoose';
import {
    WorkspaceScopeError,
    requireTenantContext,
    requireWorkspaceContext
} from '../../core/context.js';
import {
    entityPinFilter,
    prependScopeMatch,
    readScopeFilter
} from '../../core/scope.js';
import { configuredEntityOwnedCollections } from '../../core/config.js';

const OWNERSHIP_KEY = Symbol.for('@joelouf/tenancy/ownership');

/**
 * Read the declared entity ownership off a schema, or null when the schema is not entity-owned.
 * Declared, never inferred: a host schema can carry an `entityId` path that is identity, not a
 * scope stamp, so path presence is not a sound ownership signal.
 *
 * @param {import('mongoose').Schema} schema
 * @returns {import('./index.js').EntityOwnership | null}
 */
function ownershipOf(schema) {
    const carrier = /** @type {{ [key: symbol]: unknown }} */ (
        /** @type {unknown} */ (schema)
    );
    const ownership = carrier[OWNERSHIP_KEY];
    return ownership == null
        ? null
        : /** @type {import('./index.js').EntityOwnership} */ (ownership);
}

/**
 * Declare the tenancy paths on a schema. `workspaceRef` (and `entityRef`, when entity-owned)
 * name the host's model registrations — the package bakes in no model names.
 *
 * NOTE on indexes: the `schema.index()` calls here do not self-provision under `autoIndex:
 * false`; index materialization is the host's deployment concern.
 *
 * @param {import('mongoose').Schema} schema
 * @param {import('./index.js').TenantFieldsOptions} options
 * @returns {void}
 */
export function tenantFieldsPlugin(schema, options) {
    if (!options || typeof options.workspaceRef !== 'string' || options.workspaceRef === '') {
        throw new Error(
            'tenantFieldsPlugin requires a workspaceRef option naming the workspace model.'
        );
    }
    schema.add({
        workspaceId: {
            type: Schema.Types.ObjectId,
            ref: options.workspaceRef,
            required: true
        }
    });
    schema.index({ workspaceId: 1 });

    if (options.entityOwned) {
        if (typeof options.entityRef !== 'string' || options.entityRef === '') {
            throw new Error(
                'tenantFieldsPlugin requires an entityRef option when entityOwned is declared.'
            );
        }
        schema.add({
            entityId: {
                type: Schema.Types.ObjectId,
                ref: options.entityRef,
                default: null
            }
        });
        schema.index({ workspaceId: 1, entityId: 1 });
        const carrier = /** @type {{ [key: symbol]: unknown }} */ (
            /** @type {unknown} */ (schema)
        );
        carrier[OWNERSHIP_KEY] = Object.freeze({
            workspaceLevelNulls: options.workspaceLevelNulls === true
        });
    }
}

/**
 * Whether an update payload touches a guarded key through any operator, at any nesting depth
 * (dotted paths included).
 *
 * @param {readonly string[]} guardedKeys
 * @param {unknown} value
 * @returns {boolean}
 */
function payloadTouchesGuardedKey(guardedKeys, value) {
    if (value == null || typeof value !== 'object') return false;
    for (const [key, nested] of Object.entries(
        /** @type {Record<string, unknown>} */ (value)
    )) {
        if (guardedKeys.some((g) => key === g || key.startsWith(`${g}.`))) {
            return true;
        }
        if (payloadTouchesGuardedKey(guardedKeys, nested)) return true;
    }
    return false;
}

const SANCTIONED_UPDATE_OPERATORS = new Set([
    '$set',
    '$setOnInsert',
    '$unset',
    '$rename'
]);

/**
 * A filter-scoped update still ships the caller's `$set`/`$setOnInsert`/replace payload
 * verbatim, so `updateOne({ _id }, { $set: { workspaceId: other } })` would re-home an
 * in-workspace document across the boundary. Reject any update payload that reassigns
 * `workspaceId` off-context, or that touches the tenancy key through any other update operator
 * (`$unset`, `$rename`, `$min`/`$max`, arithmetic, array ops); updates that don't touch it pass
 * untouched.
 *
 * @param {import('../../core/context.js').WorkspaceContext} ctx
 * @param {Record<string, unknown>} update
 * @returns {void}
 */
function assertUpdateStaysInScope(ctx, update) {
    /** @type {Record<string, unknown>[]} */
    const payloads = [update];
    for (const op of /** @type {const} */ (['$set', '$setOnInsert'])) {
        const nested = update[op];
        if (nested && typeof nested === 'object') {
            payloads.push(/** @type {Record<string, unknown>} */ (nested));
        }
    }
    for (const payload of payloads) {
        if (
            payload.workspaceId != null &&
            String(payload.workspaceId) !== String(ctx.workspaceId)
        ) {
            throw new WorkspaceScopeError(
                'Refusing to move a document across the workspace boundary.'
            );
        }
    }
    const guardedKeys = ['workspaceId'];
    const unset = update.$unset;
    if (unset && typeof unset === 'object') {
        for (const key of guardedKeys) {
            if (key in unset) {
                throw new WorkspaceScopeError(
                    'Refusing to strip a tenancy key from a workspace-scoped document.'
                );
            }
        }
    }
    const rename = update.$rename;
    if (rename && typeof rename === 'object') {
        for (const [source, target] of Object.entries(
            /** @type {Record<string, unknown>} */ (rename)
        )) {
            if (
                guardedKeys.includes(source) ||
                guardedKeys.includes(String(target))
            ) {
                throw new WorkspaceScopeError(
                    'Refusing to rename a tenancy key on a workspace-scoped document.'
                );
            }
        }
    }
    for (const [op, payload] of Object.entries(update)) {
        if (!op.startsWith('$')) continue;
        if (SANCTIONED_UPDATE_OPERATORS.has(op)) continue;
        if (payloadTouchesGuardedKey(guardedKeys, payload)) {
            throw new WorkspaceScopeError(
                'Refusing an update operator that mutates a tenancy key on a workspace-scoped document.'
            );
        }
    }
}

/**
 * The entity write rules for a NARROWED context on an entity-owned schema: a non-null entityId
 * must sit inside the membership's set, and null (a workspace-level document) is writable only
 * where null is a real state (workspaceLevelNulls) — otherwise a narrowed member could widen an
 * entity document to workspace-level visibility.
 *
 * @param {import('../../core/context.js').WorkspaceContext} ctx
 * @param {import('./index.js').EntityOwnership} ownership
 * @param {unknown} value
 * @returns {void}
 */
function assertEntityValueAllowed(ctx, ownership, value) {
    if (ctx.entityIds === 'all') return;
    if (value == null) {
        if (ownership.workspaceLevelNulls) return;
        throw new WorkspaceScopeError(
            'Refusing a null entityId from an entity-narrowed context on a model where null is not a workspace-level state.'
        );
    }
    const allowed = ctx.entityIds.some((id) => String(id) === String(value));
    if (!allowed) {
        throw new WorkspaceScopeError(
            "Refusing to write outside the membership's entity grants."
        );
    }
}

/**
 * The entity update guards for a NARROWED context — the update-operator mirror of
 * `assertEntityValueAllowed`.
 *
 * @param {import('../../core/context.js').WorkspaceContext} ctx
 * @param {import('./index.js').EntityOwnership} ownership
 * @param {Record<string, unknown>} update
 * @returns {void}
 */
function assertEntityUpdateStaysInScope(ctx, ownership, update) {
    if (ctx.entityIds === 'all') return;
    /** @type {Record<string, unknown>[]} */
    const payloads = [update];
    for (const op of /** @type {const} */ (['$set', '$setOnInsert'])) {
        const nested = update[op];
        if (nested && typeof nested === 'object') {
            payloads.push(/** @type {Record<string, unknown>} */ (nested));
        }
    }
    for (const payload of payloads) {
        if ('entityId' in payload) {
            assertEntityValueAllowed(ctx, ownership, payload.entityId);
        }
    }
    const unset = update.$unset;
    if (unset && typeof unset === 'object' && 'entityId' in unset) {
        assertEntityValueAllowed(ctx, ownership, null);
    }
    const rename = update.$rename;
    if (rename && typeof rename === 'object') {
        for (const [source, target] of Object.entries(
            /** @type {Record<string, unknown>} */ (rename)
        )) {
            if (source === 'entityId' || String(target) === 'entityId') {
                throw new WorkspaceScopeError(
                    'Refusing to rename an entity key from an entity-narrowed context.'
                );
            }
        }
    }
    for (const [op, payload] of Object.entries(update)) {
        if (!op.startsWith('$')) continue;
        if (SANCTIONED_UPDATE_OPERATORS.has(op)) continue;
        if (payloadTouchesGuardedKey(['entityId'], payload)) {
            throw new WorkspaceScopeError(
                'Refusing an update operator that mutates an entity key from an entity-narrowed context.'
            );
        }
    }
}

/** @type {import('mongoose').MongooseQueryMiddleware[]} */
const QUERY_HOOKS = [
    'countDocuments',
    'find',
    'findOne',
    'findOneAndDelete',
    'findOneAndReplace',
    'findOneAndUpdate',
    'replaceOne',
    'updateOne',
    'updateMany',
    'deleteOne',
    'deleteMany',
    'distinct'
];

/**
 * The enforcement plugin. Requires `workspaceId` to already exist on the schema (apply
 * `tenantFieldsPlugin` first) and reads the declared entity ownership once at apply time.
 *
 * Under a workspace context every query is pinned to the context's workspace; a narrowed
 * context additionally pins entity-owned reads to its grant set (plus null, the workspace-level
 * state) and refuses writes outside it. Under a system context the plugin injects nothing — the
 * audited bypass. With no context at all, every hook throws (fail closed).
 *
 * @param {import('mongoose').Schema} schema
 * @returns {void}
 */
export function workspaceScopePlugin(schema) {
    if (!schema.path('workspaceId')) {
        throw new Error(
            'workspaceScopePlugin requires a `workspaceId` path on the schema.'
        );
    }
    const ownership = ownershipOf(schema);

    schema.pre(
        QUERY_HOOKS,
        /** @this {import('mongoose').Query<unknown, unknown>} */
        function () {
            const ctx = requireTenantContext();
            if (ctx.kind === 'system') return;
            this.where(readScopeFilter(ctx));
            const pin = ownership ? entityPinFilter(ctx) : null;
            if (pin) {
                // Explicit $and composition: mquery's where-merge silently DROPS an $in pin
                // when the caller's filter already carries a bare entityId equality (verified
                // on mongoose 9.6.3). $and can only narrow.
                this.setQuery({
                    $and: [
                        this.getFilter(),
                        { ...readScopeFilter(ctx), ...pin }
                    ]
                });
            }
            const update = this.getUpdate();
            if (Array.isArray(update)) {
                throw new WorkspaceScopeError(
                    'Refusing a pipeline update on a workspace-scoped model.'
                );
            }
            if (update) {
                assertUpdateStaysInScope(
                    ctx,
                    /** @type {Record<string, unknown>} */ (update)
                );
                if (ownership) {
                    assertEntityUpdateStaysInScope(
                        ctx,
                        ownership,
                        /** @type {Record<string, unknown>} */ (update)
                    );
                }
            }
        }
    );

    schema.pre(
        'aggregate',
        /** @this {import('mongoose').Aggregate<unknown[]>} */
        function () {
            const ctx = requireTenantContext();
            if (ctx.kind === 'system') return;
            const pin = ownership ? entityPinFilter(ctx) : null;
            prependScopeMatch(
                this.pipeline(),
                pin
                    ? { ...readScopeFilter(ctx), ...pin }
                    : readScopeFilter(ctx),
                // A leading $match can cover the workspace without covering the entity pin; a
                // narrowed context always prepends.
                { alwaysPrepend: pin != null }
            );
        }
    );

    // Stamp on `validate` (which runs before save) so an auto-populated `workspaceId` is
    // present before a `required` check can reject it.
    schema.pre(
        'validate',
        /** @this {import('mongoose').Document} */
        function () {
            const ctx = requireTenantContext();
            if (ctx.kind === 'system') return;
            const current = /** @type {unknown} */ (this.get('workspaceId'));
            if (current == null) {
                this.set('workspaceId', ctx.workspaceId);
            } else if (String(current) !== String(ctx.workspaceId)) {
                throw new WorkspaceScopeError(
                    'Refusing to save a document across the workspace boundary.'
                );
            }
            if (ownership) {
                assertEntityValueAllowed(
                    ctx,
                    ownership,
                    /** @type {unknown} */ (this.get('entityId'))
                );
            }
        }
    );

    schema.pre(
        'insertMany',
        /** @param {unknown} docs */
        function (docs) {
            const ctx = requireTenantContext();
            if (ctx.kind === 'system') return;
            if (!Array.isArray(docs)) return;
            for (const doc of docs) {
                if (doc && typeof doc === 'object') {
                    const record = /** @type {Record<string, unknown>} */ (doc);
                    if (record.workspaceId == null) {
                        record.workspaceId = ctx.workspaceId;
                    } else if (
                        String(record.workspaceId) !== String(ctx.workspaceId)
                    ) {
                        throw new WorkspaceScopeError(
                            'Refusing to insert a document across the workspace boundary.'
                        );
                    }
                    if (ownership) {
                        assertEntityValueAllowed(
                            ctx,
                            ownership,
                            record.entityId ?? null
                        );
                    }
                }
            }
        }
    );
}

/**
 * Build a `$lookup` whose sub-pipeline is workspace-scoped. This is the ONLY sanctioned way to
 * join collections: a `$lookup` sub-pipeline does NOT inherit the parent's `$match`, so an
 * unscoped join is a cross-workspace leak.
 *
 * Reads the ambient workspace context, so it must be called inside runWithWorkspace(). Consults
 * the configured entity-owned collection list and THROWS when configuration has not happened:
 * an unknown list would silently skip the entity pin on a narrowed context — cross-entity
 * widening — so the refusal is fail-closed, never fail-open.
 *
 * @param {import('./index.js').ScopedLookupOptions} options
 * @returns {import('./index.js').ScopedLookupStage}
 */
export function scopedLookup(options) {
    const ctx = requireWorkspaceContext();
    const entityOwnedCollections = configuredEntityOwnedCollections();
    if (entityOwnedCollections === null) {
        throw new WorkspaceScopeError(
            'scopedLookup requires configureTenancy({ entityOwnedCollections }) to have run before any join is built. ' +
                'Without the entity-owned collection list a narrowed context could silently skip the entity pin. Refusing to build the join.'
        );
    }
    const workspaceCondition = { $eq: ['$workspaceId', ctx.workspaceId] };
    // Entity-owned joins additionally pin the entity for narrowed contexts. $ifNull normalizes
    // missing fields to null: aggregation expressions do not mirror the match stage's
    // $in-with-null semantics for absent paths.
    const entityCondition =
        ctx.entityIds !== 'all' && entityOwnedCollections.includes(options.from)
            ? {
                  $in: [
                      { $ifNull: ['$entityId', null] },
                      [null, ...ctx.entityIds]
                  ]
              }
            : null;
    const guard = {
        $match: {
            $expr: entityCondition
                ? { $and: [workspaceCondition, entityCondition] }
                : workspaceCondition
        }
    };
    return {
        // scope-guard-allow: raw-$lookup this is the scopedLookup definition itself
        $lookup: {
            from: options.from,
            as: options.as,
            ...(options.localField ? { localField: options.localField } : {}),
            ...(options.foreignField
                ? { foreignField: options.foreignField }
                : {}),
            ...(options.let ? { let: options.let } : {}),
            pipeline: [guard, ...(options.pipeline ?? [])]
        }
    };
}
