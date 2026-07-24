// The configure-order pin. This file MUST run in its own process with configureTenancy never
// called before the first assertion (node --test gives every test file a fresh process), so it
// proves scopedLookup fails CLOSED pre-configuration and works order-independently after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    configureTenancy,
    configuredEntityOwnedCollections,
    runWithWorkspace
} from '../index.js';
import { scopedLookup } from '../adapters/mongoose/index.js';
import { oid, workspaceContext, expectScopeRefusal } from './_harness.js';

test('scopedLookup BEFORE configureTenancy throws (fail closed, never fail open)', async () => {
    assert.equal(configuredEntityOwnedCollections(), null);
    await runWithWorkspace(workspaceContext(), async () => {
        await expectScopeRefusal(
            async () => scopedLookup({ from: 'leases', as: '_leases' }),
            /configureTenancy/
        );
    });
});

test('scopedLookup with NO context refuses before it ever consults configuration', async () => {
    await expectScopeRefusal(
        async () => scopedLookup({ from: 'leases', as: '_leases' }),
        /No tenant context/
    );
});

test('after configureTenancy the entity pin applies, regardless of schema/model import order', async () => {
    configureTenancy({
        entityOwnedCollections: ['properties', 'leases', 'files']
    });
    assert.deepEqual(configuredEntityOwnedCollections(), [
        'properties',
        'leases',
        'files'
    ]);

    const entityA = oid();
    const narrowed = workspaceContext({ entityIds: [entityA] });

    await runWithWorkspace(narrowed, async () => {
        const pinned = scopedLookup({
            from: 'leases',
            as: '_leases',
            localField: '_id',
            foreignField: 'property'
        });
        const sub = /** @type {{ $match: { $expr: Record<string, unknown> } }[]} */ (
            pinned.$lookup.pipeline
        );
        assert.ok('$and' in sub[0].$match.$expr, 'a narrowed join carries the entity pin');

        const workspaceOnly = scopedLookup({
            from: 'contacts',
            as: '_contacts'
        });
        const workspaceSub =
            /** @type {{ $match: { $expr: Record<string, unknown> } }[]} */ (
                workspaceOnly.$lookup.pipeline
            );
        assert.ok(
            '$eq' in workspaceSub[0].$match.$expr,
            'a non-entity-owned join carries the workspace guard alone'
        );
    });
});

test('an all-entities context gets the plain workspace guard even on an entity-owned collection', async () => {
    await runWithWorkspace(workspaceContext(), async () => {
        const stage = scopedLookup({ from: 'leases', as: '_leases' });
        const sub = /** @type {{ $match: { $expr: Record<string, unknown> } }[]} */ (
            stage.$lookup.pipeline
        );
        assert.ok('$eq' in sub[0].$match.$expr);
    });
});

test('reconfiguring replaces the collection list (last write wins), and an empty list is a valid statement', async () => {
    configureTenancy({ entityOwnedCollections: [] });
    assert.deepEqual(configuredEntityOwnedCollections(), []);
    const entityA = oid();
    await runWithWorkspace(
        workspaceContext({ entityIds: [entityA] }),
        async () => {
            const stage = scopedLookup({ from: 'leases', as: '_leases' });
            const sub =
                /** @type {{ $match: { $expr: Record<string, unknown> } }[]} */ (
                    stage.$lookup.pipeline
                );
            assert.ok(
                '$eq' in sub[0].$match.$expr,
                'with no collection declared entity-owned, no entity pin applies'
            );
        }
    );
});
