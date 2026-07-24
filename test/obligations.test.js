import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    registerDeletionObligation,
    collectDeletionObligations
} from '../index.js';
import { oid } from './_harness.js';

test('the registry ships empty: a collect with no providers reports no obligations', async () => {
    assert.deepEqual(await collectDeletionObligations(oid(), null), []);
});

test('a provider reports its obligations with its name attached, on the caller session', async () => {
    const workspaceId = oid();
    const session = { id: 'txn-session' };
    /** @type {unknown[]} */
    const seenSessions = [];
    const unregister = registerDeletionObligation({
        name: 'ledger',
        async collect(id, s) {
            assert.equal(String(id), String(workspaceId));
            seenSessions.push(s);
            return ['3 posted journal entries', '1 open period'];
        }
    });
    try {
        const obligations = await collectDeletionObligations(
            workspaceId,
            session
        );
        assert.deepEqual(obligations, [
            { provider: 'ledger', description: '3 posted journal entries' },
            { provider: 'ledger', description: '1 open period' }
        ]);
        assert.equal(seenSessions[0], session, 'the session passes through opaquely');
    } finally {
        unregister();
    }
});

test('an empty answer from a provider is no objection', async () => {
    const unregister = registerDeletionObligation({
        name: 'quiet',
        collect: async () => []
    });
    try {
        assert.deepEqual(await collectDeletionObligations(oid(), null), []);
    } finally {
        unregister();
    }
});

test('multiple providers aggregate in registration order and the unregister handle removes exactly one', async () => {
    const first = registerDeletionObligation({
        name: 'first',
        collect: async () => ['a']
    });
    const second = registerDeletionObligation({
        name: 'second',
        collect: async () => ['b']
    });
    try {
        assert.deepEqual(
            (await collectDeletionObligations(oid(), null)).map(
                (o) => o.provider
            ),
            ['first', 'second']
        );
        first();
        assert.deepEqual(
            (await collectDeletionObligations(oid(), null)).map(
                (o) => o.provider
            ),
            ['second']
        );
    } finally {
        first();
        second();
    }
});

test('the provider set lives in the Symbol.for stash, not module scope', () => {
    const stash = /** @type {{ [key: symbol]: unknown }} */ (
        /** @type {unknown} */ (globalThis)
    );
    const providers = stash[Symbol.for('@joelouf/tenancy/deletion-obligations')];
    assert.ok(providers instanceof Set);
    const unregister = registerDeletionObligation({
        name: 'stash-probe',
        collect: async () => []
    });
    try {
        assert.ok(
            [...(/** @type {Set<{ name: string }>} */ (providers))].some(
                (p) => p.name === 'stash-probe'
            )
        );
    } finally {
        unregister();
    }
});
