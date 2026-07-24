import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createWorkspaceResolver,
    LAST_SEEN_WRITE_WINDOW_MS,
    NULL_WORKSPACE_ID,
    runAsSystem
} from '../index.js';
import { oid, memoryDirectory, recordingLogger } from './_harness.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

const userId = oid();
const workspaceId = oid();
const membershipId = oid();
const slug = 'acme';

/**
 * @param {Partial<import('../core/resolver.js').DirectoryMembership>} [membershipOver]
 * @param {Parameters<typeof memoryDirectory>[0]} [seedOver]
 */
const seededDirectory = (membershipOver = {}, seedOver = {}) =>
    memoryDirectory({
        workspaces: [{ _id: workspaceId, slug }],
        memberships: [
            {
                _id: membershipId,
                userId,
                workspaceId,
                accessRole: 'manager',
                invitationId: null,
                lastSeenAt: null,
                ...membershipOver
            }
        ],
        ...seedOver
    });

test('resolves a member to a context with the slug, workspace, verbatim accessRole, and invited: false', async () => {
    const directory = seededDirectory();
    const resolve = createWorkspaceResolver({ directory });
    const result = await resolve({ userId, workspaceSlug: slug });
    assert.ok(result.ok);
    assert.equal(result.context.kind, 'workspace');
    assert.equal(result.context.slug, slug);
    assert.equal(String(result.context.workspaceId), String(workspaceId));
    assert.equal(String(result.context.userId), String(userId));
    assert.equal(result.context.accessRole, 'manager');
    assert.equal(result.context.invited, false);
});

test('zero grant rows resolve to "all" — the absence of narrowing', async () => {
    const resolve = createWorkspaceResolver({ directory: seededDirectory() });
    const result = await resolve({ userId, workspaceSlug: slug });
    assert.ok(result.ok);
    assert.equal(result.context.entityIds, 'all');
});

test('grant rows narrow the context to exactly those entities — never widen', async () => {
    const entityA = oid();
    const entityB = oid();
    const directory = seededDirectory(
        {},
        {
            grants: [
                { workspaceId, membershipId, entityId: entityA },
                { workspaceId, membershipId, entityId: entityB }
            ]
        }
    );
    const resolve = createWorkspaceResolver({ directory });
    const result = await resolve({ userId, workspaceSlug: slug });
    assert.ok(result.ok);
    assert.notEqual(result.context.entityIds, 'all');
    assert.deepEqual(
        /** @type {import('../core/types.js').ObjectIdLike[]} */ (
            result.context.entityIds
        ).map(String),
        [String(entityA), String(entityB)]
    );
});

test('invited derives from the membership invitationId', async () => {
    const invited = createWorkspaceResolver({
        directory: seededDirectory({ invitationId: oid() })
    });
    const invitedResult = await invited({ userId, workspaceSlug: slug });
    assert.ok(invitedResult.ok);
    assert.equal(invitedResult.context.invited, true);
});

test('a missing workspace still calls findActiveMembership — with the null sentinel (enumeration resistance)', async () => {
    const directory = seededDirectory();
    const resolve = createWorkspaceResolver({ directory });
    const result = await resolve({
        userId,
        workspaceSlug: 'no-such-workspace'
    });
    assert.deepEqual(result, { ok: false, reason: 'workspace' });
    const membershipCalls = directory.calls.filter(
        (call) => call.method === 'findActiveMembership'
    );
    assert.equal(membershipCalls.length, 1, 'the membership lookup is UNCONDITIONAL');
    assert.equal(String(membershipCalls[0].args[1]), String(NULL_WORKSPACE_ID));
    assert.equal(
        directory.calls.filter((call) => call.method === 'listEntityGrants')
            .length,
        0,
        'no grant read on a refusal'
    );
});

test('both refusal causes issue the same directory reads in the same order (no query-count oracle)', async () => {
    const missingWorkspace = seededDirectory();
    await createWorkspaceResolver({ directory: missingWorkspace })({
        userId,
        workspaceSlug: 'no-such-workspace'
    });

    const outsider = seededDirectory();
    const outsiderResult = await createWorkspaceResolver({
        directory: outsider
    })({ userId: oid(), workspaceSlug: slug });
    assert.deepEqual(outsiderResult, { ok: false, reason: 'membership' });

    assert.deepEqual(
        missingWorkspace.calls.map((call) => call.method),
        outsider.calls.map((call) => call.method)
    );
});

test('a workspace the user is no member of refuses with reason "membership"', async () => {
    const resolve = createWorkspaceResolver({ directory: seededDirectory() });
    const result = await resolve({ userId: oid(), workspaceSlug: slug });
    assert.deepEqual(result, { ok: false, reason: 'membership' });
});

test('a fresh lastSeenAt inside the window suppresses the write entirely', async () => {
    let touched = 0;
    const directory = seededDirectory(
        { lastSeenAt: new Date() },
        { recordLastSeen: () => void (touched += 1) }
    );
    const resolve = createWorkspaceResolver({ directory });
    const result = await resolve({ userId, workspaceSlug: slug });
    assert.ok(result.ok);
    await settle();
    assert.equal(touched, 0);
});

test('a stale lastSeenAt triggers exactly one fire-and-forget write with the window-derived staleBefore', async () => {
    /** @type {Date[]} */
    const staleBefores = [];
    const directory = seededDirectory(
        { lastSeenAt: new Date(Date.now() - 2 * LAST_SEEN_WRITE_WINDOW_MS) },
        {
            recordLastSeen: (membershipIdArg, staleBefore) => {
                assert.equal(String(membershipIdArg), String(membershipId));
                staleBefores.push(staleBefore);
            }
        }
    );
    const resolve = createWorkspaceResolver({ directory });
    const before = Date.now();
    const result = await resolve({ userId, workspaceSlug: slug });
    const after = Date.now();
    assert.ok(result.ok);
    await settle();
    assert.equal(staleBefores.length, 1);
    const staleBefore = staleBefores[0].getTime();
    assert.ok(staleBefore >= before - LAST_SEEN_WRITE_WINDOW_MS);
    assert.ok(staleBefore <= after - LAST_SEEN_WRITE_WINDOW_MS);
});

test('a null lastSeenAt counts as stale and gets the touch', async () => {
    let touched = 0;
    const directory = seededDirectory(
        { lastSeenAt: null },
        { recordLastSeen: () => void (touched += 1) }
    );
    await createWorkspaceResolver({ directory })({
        userId,
        workspaceSlug: slug
    });
    await settle();
    assert.equal(touched, 1);
});

test('a custom lastSeenWriteWindowMs governs the staleness arithmetic', async () => {
    let touched = 0;
    const directory = seededDirectory(
        { lastSeenAt: new Date(Date.now() - 60 * 1000) },
        { recordLastSeen: () => void (touched += 1) }
    );
    const wideWindow = createWorkspaceResolver({
        directory,
        lastSeenWriteWindowMs: 10 * 60 * 1000
    });
    await wideWindow({ userId, workspaceSlug: slug });
    await settle();
    assert.equal(touched, 0, 'inside the widened window: no write');

    const narrowWindow = createWorkspaceResolver({
        directory,
        lastSeenWriteWindowMs: 1000
    });
    await narrowWindow({ userId, workspaceSlug: slug });
    await settle();
    assert.equal(touched, 1, 'outside the narrowed window: one write');
});

test('an ambient system context suppresses the lastSeen touch (system flows leave no presence trace)', async () => {
    let touched = 0;
    const directory = seededDirectory(
        { lastSeenAt: null },
        { recordLastSeen: () => void (touched += 1) }
    );
    const resolve = createWorkspaceResolver({ directory });
    await runAsSystem('test-system-resolution', async () => {
        const result = await resolve({ userId, workspaceSlug: slug });
        assert.ok(result.ok);
    });
    await settle();
    assert.equal(touched, 0);
});

test('a rejected lastSeen write is swallowed, logged through the logger port, and never fails resolution', async () => {
    const logger = recordingLogger();
    const directory = seededDirectory(
        { lastSeenAt: null },
        {
            recordLastSeen: () =>
                Promise.reject(new Error('write concern lost'))
        }
    );
    const resolve = createWorkspaceResolver({ directory, logger });
    const result = await resolve({ userId, workspaceSlug: slug });
    assert.ok(result.ok, 'the context returns before and despite the write');
    await settle();
    assert.equal(logger.entries.length, 1);
    assert.equal(logger.entries[0].level, 'error');
    assert.equal(logger.entries[0].message, 'membership lastSeenAt write failed');
    assert.equal(
        logger.entries[0].fields?.membershipId,
        String(membershipId)
    );
    assert.equal(logger.entries[0].fields?.error, 'write concern lost');
});

test('a directory without recordLastSeen resolves fine — presence bookkeeping is optional', async () => {
    const resolve = createWorkspaceResolver({ directory: seededDirectory() });
    const result = await resolve({ userId, workspaceSlug: slug });
    assert.ok(result.ok);
});

test('NULL_WORKSPACE_ID is the frozen all-zero id and equals only its own hex', () => {
    assert.equal(NULL_WORKSPACE_ID.toHexString(), '000000000000000000000000');
    assert.equal(String(NULL_WORKSPACE_ID), '000000000000000000000000');
    assert.ok(NULL_WORKSPACE_ID.equals('000000000000000000000000'));
    assert.ok(!NULL_WORKSPACE_ID.equals(String(oid())));
    assert.ok(Object.isFrozen(NULL_WORKSPACE_ID));
});
