import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    readScopeFilter,
    entityPinFilter,
    scopeMatchStage,
    prependScopeMatch
} from '../index.js';
import { oid, workspaceContext } from './_harness.js';

const wsA = oid();
const wsB = oid();

/** @returns {import('../core/context.js').WorkspaceContext} */
const wctx = (/** @type {Partial<import('../core/context.js').WorkspaceContext>} */ over = {}) => ({
    kind: 'workspace',
    ...workspaceContext({ workspaceId: wsA }),
    ...over
});

test('readScopeFilter pins workspaceId and nothing else', () => {
    assert.deepEqual(readScopeFilter(wctx()), { workspaceId: wsA });
});

test('entityPinFilter is null for an all-entities context', () => {
    assert.equal(entityPinFilter(wctx()), null);
});

test('entityPinFilter pins the grant set plus null (the workspace-level state) for a narrowed context', () => {
    const entityA = oid();
    const entityB = oid();
    const pin = entityPinFilter(wctx({ entityIds: [entityA, entityB] }));
    assert.deepEqual(pin, { entityId: { $in: [null, entityA, entityB] } });
});

test('prependScopeMatch prepends a workspace $match', () => {
    /** @type {object[]} */
    const pipeline = [{ $sort: { name: 1 } }];
    prependScopeMatch(pipeline, { workspaceId: wsA });
    assert.deepEqual(pipeline[0], scopeMatchStage({ workspaceId: wsA }));
    assert.equal(pipeline.length, 2);
});

test('prependScopeMatch is idempotent — does not stack a second identical guard', () => {
    /** @type {object[]} */
    const pipeline = [{ $match: { workspaceId: wsA } }];
    prependScopeMatch(pipeline, { workspaceId: wsA });
    assert.equal(pipeline.length, 1);
});

test('prependScopeMatch does not trust a foreign workspace $match already at the front', () => {
    /** @type {object[]} */
    const pipeline = [{ $match: { workspaceId: wsB } }];
    prependScopeMatch(pipeline, { workspaceId: wsA });
    assert.equal(pipeline.length, 2);
    assert.deepEqual(pipeline[0], scopeMatchStage({ workspaceId: wsA }));
});

test('alwaysPrepend forces the guard in even over an identical leading $match (the narrowed-context rule)', () => {
    /** @type {object[]} */
    const pipeline = [{ $match: { workspaceId: wsA } }];
    prependScopeMatch(
        pipeline,
        { workspaceId: wsA, entityId: { $in: [null, oid()] } },
        { alwaysPrepend: true }
    );
    assert.equal(pipeline.length, 2);
    assert.ok(
        '$match' in /** @type {Record<string, unknown>} */ (pipeline[0])
    );
});

test('scopeMatchStage copies the filter — mutating the stage never mutates the input', () => {
    const filter = { workspaceId: wsA };
    const stage = scopeMatchStage(filter);
    stage.$match.extra = true;
    assert.deepEqual(filter, { workspaceId: wsA });
});
