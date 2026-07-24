// The split-copy regression pin (extraction criterion: two isolated import copies share the
// ALS, the schema-attached ownership, the configured collection set, AND the obligations
// registry).
//
// MECHANISM: Node's ESM loader keys module instances by resolved URL, so importing the same
// file with distinct query strings ('...?copy=a' vs '...?copy=b', via the harness's
// importFreshCopy) executes the module body twice and yields two genuinely separate module
// instances in one realm, the same shape a bundler's per-route duplicate or a symlink realpath
// split produces. Anything module-scoped diverges between the copies; anything keyed on
// Symbol.for (or attached to a shared schema object) must not. For the ownership pin the copies
// are two instances of the whole adapter module: copy A's tenantFieldsPlugin writes the
// ownership record, copy B's workspaceScopePlugin reads it off the schema object itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from 'mongoose';
import { oid, workspaceContext, importFreshCopy } from './_harness.js';

/** @typedef {typeof import('../core/context.js')} ContextModule */
/** @typedef {typeof import('../core/config.js')} ConfigModule */
/** @typedef {typeof import('../core/deletion-obligations.js')} ObligationsModule */
/** @typedef {typeof import('../adapters/mongoose/index.js')} AdapterModule */

test('two context.js copies share one AsyncLocalStorage through the Symbol.for stash', async () => {
    const a = /** @type {ContextModule} */ (
        await importFreshCopy('core/context.js', 'a')
    );
    const b = /** @type {ContextModule} */ (
        await importFreshCopy('core/context.js', 'b')
    );
    assert.notEqual(a, b, 'the query strings must yield distinct module instances');

    const ctx = workspaceContext({ slug: 'w-split' });
    await a.runWithWorkspace(ctx, async () => {
        const seenByB = b.requireWorkspaceContext();
        assert.equal(seenByB.slug, 'w-split');
        assert.equal(String(seenByB.workspaceId), String(ctx.workspaceId));
    });
    assert.equal(b.getTenantContext(), undefined);

    await b.runAsSystem('split-copy-probe', async () => {
        assert.equal(a.requireTenantContext().kind, 'system');
    });
});

test('two config.js copies share one configured collection set', async () => {
    const a = /** @type {ConfigModule} */ (
        await importFreshCopy('core/config.js', 'a')
    );
    const b = /** @type {ConfigModule} */ (
        await importFreshCopy('core/config.js', 'b')
    );
    assert.notEqual(a, b);

    a.configureTenancy({ entityOwnedCollections: ['split_probes'] });
    assert.deepEqual(b.configuredEntityOwnedCollections(), ['split_probes']);

    /** @type {import('../core/types.js').LoggerPort} */
    const logger = { log() {} };
    b.configureTenancy({ logger });
    assert.equal(a.configuredLogger(), logger);
    a.configureTenancy({ logger: null });
});

test('two deletion-obligations copies share one provider registry', async () => {
    const a = /** @type {ObligationsModule} */ (
        await importFreshCopy('core/deletion-obligations.js', 'a')
    );
    const b = /** @type {ObligationsModule} */ (
        await importFreshCopy('core/deletion-obligations.js', 'b')
    );
    assert.notEqual(a, b);

    const unregister = a.registerDeletionObligation({
        name: 'split-ledger',
        collect: async () => ['1 unposted batch']
    });
    try {
        const seenByB = await b.collectDeletionObligations(oid(), null);
        assert.deepEqual(seenByB, [
            { provider: 'split-ledger', description: '1 unposted batch' }
        ]);
    } finally {
        unregister();
    }
    assert.deepEqual(await b.collectDeletionObligations(oid(), null), []);
});

test('ownership written by one adapter copy is honored by the other (schema-attached, no registry to split)', async () => {
    const adapterA = /** @type {AdapterModule} */ (
        await importFreshCopy('adapters/mongoose/index.js', 'a')
    );
    const adapterB = /** @type {AdapterModule} */ (
        await importFreshCopy('adapters/mongoose/index.js', 'b')
    );
    assert.notEqual(adapterA, adapterB);

    const { runWithWorkspace } = await import('../core/context.js');

    const schema = new Schema({ name: String });
    adapterA.tenantFieldsPlugin(schema, {
        workspaceRef: 'Workspace',
        entityRef: 'Entity',
        entityOwned: true
    });
    adapterB.workspaceScopePlugin(schema);

    const ownership = /** @type {{ [key: symbol]: unknown }} */ (
        /** @type {unknown} */ (schema)
    )[Symbol.for('@joelouf/tenancy/ownership')];
    assert.deepEqual(ownership, { workspaceLevelNulls: false });

    const mongoose = (await import('mongoose')).default;
    const Probe =
        mongoose.models.SplitCopyProbe ??
        mongoose.model('SplitCopyProbe', schema, 'split_copy_probes');

    const grantedEntity = oid();
    const foreignEntity = oid();
    await runWithWorkspace(
        workspaceContext({ entityIds: [grantedEntity] }),
        async () => {
            const outside = new Probe({
                name: 'outside-grants',
                entityId: foreignEntity.toString()
            });
            await assert.rejects(
                () => outside.validate(),
                (/** @type {unknown} */ err) =>
                    err instanceof Error &&
                    err.name === 'WorkspaceScopeError' &&
                    /entity grants/.test(err.message),
                'copy B enforces the narrowing copy A declared; the split-registry fail-open is dead'
            );

            const inside = new Probe({
                name: 'inside-grants',
                entityId: grantedEntity.toString()
            });
            await inside.validate();
            assert.equal(
                String(inside.get('entityId')),
                String(grantedEntity)
            );
        }
    );
});
