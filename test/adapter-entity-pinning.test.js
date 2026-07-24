// The entity-pinning isolation suite — the machinery-generic half of the consumer's
// entity-pinning pins, re-hosted onto probe schemas with the narrowed context produced by the
// PACKAGE resolver over a stubbed directory (so entityIds resolution is pinned to the resolver,
// not to any host model). DB-backed; skips cleanly without TENANCY_TEST_DB_URI, refuses a
// non-local one.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Schema, Types } from 'mongoose';
import {
    configureTenancy,
    createWorkspaceResolver,
    runAsSystem,
    runWithWorkspace
} from '../index.js';
import {
    tenantFieldsPlugin,
    workspaceScopePlugin,
    scopedLookup
} from '../adapters/mongoose/index.js';
import {
    workspaceContext,
    memoryDirectory,
    expectScopeRefusal,
    testDbUri,
    DB_SKIP_REASON
} from './_harness.js';

const DB_URI = testDbUri();

const OWNED_COLLECTION = 'pin_probe_owned';
const FILES_COLLECTION = 'pin_probe_files';

configureTenancy({
    entityOwnedCollections: [OWNED_COLLECTION, FILES_COLLECTION]
});

const ownerUser = new Types.ObjectId();
const narrowedUser = new Types.ObjectId();
const workspaceId = new Types.ObjectId();
const membershipId = new Types.ObjectId();
const slug = 'entity-pin-probe';
const entityA = new Types.ObjectId();
const entityB = new Types.ObjectId();

const ownerCtx = workspaceContext({
    userId: ownerUser,
    workspaceId,
    slug,
    entityIds: 'all'
});

const directory = memoryDirectory({
    workspaces: [{ _id: workspaceId, slug }],
    memberships: [
        {
            _id: membershipId,
            userId: narrowedUser,
            workspaceId,
            accessRole: 'manager',
            invitationId: null,
            lastSeenAt: null
        }
    ],
    grants: [{ workspaceId, membershipId, entityId: entityA }]
});

/**
 * @param {string} modelName
 * @param {string} collection
 * @param {{ workspaceLevelNulls?: boolean }} [ownershipShape]
 */
const ownedProbeModel = (modelName, collection, ownershipShape = {}) => {
    const schema = new Schema({ name: String });
    tenantFieldsPlugin(schema, {
        workspaceRef: 'PinProbeWorkspace',
        entityRef: 'PinProbeEntity',
        entityOwned: true,
        workspaceLevelNulls: ownershipShape.workspaceLevelNulls
    });
    workspaceScopePlugin(schema);
    return (
        mongoose.models[modelName] ??
        mongoose.model(modelName, schema, collection)
    );
};

const plainProbeModel = () => {
    const schema = new Schema({ name: String, ref: Schema.Types.ObjectId });
    tenantFieldsPlugin(schema, { workspaceRef: 'PinProbeWorkspace' });
    workspaceScopePlugin(schema);
    return (
        mongoose.models.PinProbePlain ??
        mongoose.model('PinProbePlain', schema, 'pin_probe_plain')
    );
};

test('the resolver materializes the narrowed entityIds from grant rows, not by hand', async () => {
    const resolve = createWorkspaceResolver({ directory });
    const result = await resolve({ userId: narrowedUser, workspaceSlug: slug });
    assert.ok(result.ok);
    assert.notEqual(result.context.entityIds, 'all');
    assert.deepEqual(
        /** @type {import('../core/types.js').ObjectIdLike[]} */ (
            result.context.entityIds
        ).map(String),
        [String(entityA)]
    );
});

if (!DB_URI) {
    test('entity pinning isolation over a live mongod', { skip: DB_SKIP_REASON }, () => {});
} else {
    describe('entity pinning isolation — workspace with entities A/B, member narrowed to A (local test DB)', () => {
        const Owned = ownedProbeModel('PinProbeOwned', OWNED_COLLECTION);
        const FilesLike = ownedProbeModel('PinProbeFiles', FILES_COLLECTION, {
            workspaceLevelNulls: true
        });
        const Plain = plainProbeModel();

        /** @type {import('../core/context.js').WorkspaceContext} */
        let narrowedCtx;
        /** @type {Types.ObjectId} */
        let ownedA;
        /** @type {Types.ObjectId} */
        let ownedB;
        /** @type {Types.ObjectId} */
        let ownedNull;

        before(async () => {
            await mongoose.connect(DB_URI);
            await runAsSystem('test-seed', async () => {
                await Owned.deleteMany({});
                await FilesLike.deleteMany({});
                await Plain.deleteMany({});

                const a = await Owned.create({
                    name: 'owned-a',
                    workspaceId,
                    entityId: entityA
                });
                ownedA = /** @type {Types.ObjectId} */ (a._id);
                const b = await Owned.create({
                    name: 'owned-b',
                    workspaceId,
                    entityId: entityB
                });
                ownedB = /** @type {Types.ObjectId} */ (b._id);
                const nullRow = await Owned.create({
                    name: 'owned-null',
                    workspaceId,
                    entityId: null
                });
                ownedNull = /** @type {Types.ObjectId} */ (nullRow._id);

                await FilesLike.create({
                    name: 'file-a',
                    workspaceId,
                    entityId: entityA
                });
                await FilesLike.create({
                    name: 'file-b',
                    workspaceId,
                    entityId: entityB
                });
                await FilesLike.create({
                    name: 'file-workspace-level',
                    workspaceId,
                    entityId: null
                });

                await Plain.create({
                    name: 'parent-of-a',
                    workspaceId,
                    ref: a._id
                });
                await Plain.create({
                    name: 'parent-of-b',
                    workspaceId,
                    ref: b._id
                });
            });

            const resolve = createWorkspaceResolver({ directory });
            const resolution = await resolve({
                userId: narrowedUser,
                workspaceSlug: slug
            });
            assert.ok(resolution.ok);
            narrowedCtx = resolution.context;
        });

        after(async () => {
            await runAsSystem('test-teardown', async () => {
                await Owned.deleteMany({});
                await FilesLike.deleteMany({});
                await Plain.deleteMany({});
            });
            await mongoose.disconnect();
        });

        test('find/findOne return zero B rows; the null-entityId row stays visible', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                const names = (await Owned.find({}).lean())
                    .map((r) => r.name)
                    .sort();
                assert.deepEqual(names, ['owned-a', 'owned-null']);
                assert.equal(await Owned.findOne({ _id: ownedB }).lean(), null);

                const fileNames = (await FilesLike.find({}).lean())
                    .map((r) => r.name)
                    .sort();
                assert.deepEqual(fileNames, ['file-a', 'file-workspace-level']);
            });
        });

        test('count and distinct carry the pin', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                assert.equal(await Owned.countDocuments({}), 2);
                const stamps = await Owned.distinct('entityId');
                assert.deepEqual(
                    stamps.map(String).sort(),
                    [String(entityA), 'null'].sort()
                );
                assert.ok(!stamps.map(String).includes(String(entityB)));
            });
        });

        test('the merge-drop attack shape returns zero rows, not B rows', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                const rows = await Owned.find({ entityId: entityB }).exec();
                assert.equal(rows.length, 0);
            });
        });

        test('aggregate stays pinned even with a leading same-workspace $match', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                const rows = await Owned.aggregate([
                    { $match: { workspaceId } },
                    { $project: { _id: 1 } }
                ]);
                assert.deepEqual(
                    rows.map((r) => String(r._id)).sort(),
                    [String(ownedA), String(ownedNull)].sort()
                );
            });
        });

        test('a scopedLookup join from a visible parent refuses the B row', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                const join = () =>
                    scopedLookup({
                        from: OWNED_COLLECTION,
                        localField: 'ref',
                        foreignField: '_id',
                        as: '_owned'
                    });

                const fromBParent = await Plain.aggregate([
                    { $match: { name: 'parent-of-b' } },
                    join()
                ]);
                assert.equal(fromBParent.length, 1);
                assert.deepEqual(fromBParent[0]._owned, []);

                const fromAParent = await Plain.aggregate([
                    { $match: { name: 'parent-of-a' } },
                    join()
                ]);
                assert.equal(fromAParent.length, 1);
                assert.equal(fromAParent[0]._owned.length, 1);
            });
        });

        test('a narrowed member cannot create a row stamped to B', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                await expectScopeRefusal(
                    () =>
                        Owned.create({
                            name: 'forbidden',
                            entityId: entityB
                        }),
                    /entity grants/
                );
            });
        });

        test('a $set moving an A row to B rejects, leaving it untouched', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                await expectScopeRefusal(() =>
                    Owned.updateOne(
                        { _id: ownedA },
                        { $set: { entityId: entityB } }
                    ).exec()
                );
            });
            await runAsSystem('test-verify', async () => {
                const still = await Owned.findOne({ _id: ownedA }).lean();
                assert.equal(
                    String(/** @type {NonNullable<typeof still>} */ (still).entityId),
                    String(entityA)
                );
            });
        });

        test('a $set to null rejects where null is not a workspace-level state', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                await expectScopeRefusal(
                    () =>
                        Owned.updateOne(
                            { _id: ownedA },
                            { $set: { entityId: null } }
                        ).exec(),
                    /null entityId/
                );
            });
        });

        test('a narrowed member creates a null-entityId row where nulls are workspace-level (the files predicate)', async () => {
            /** @type {unknown} */
            let createdId;
            await runWithWorkspace(narrowedCtx, async () => {
                const created = await FilesLike.create({
                    name: 'narrowed-null'
                });
                createdId = created._id;
            });
            await runAsSystem('test-verify', async () => {
                const row = await FilesLike.findOne({ _id: createdId }).lean();
                assert.notEqual(row, null);
                assert.equal(
                    /** @type {NonNullable<typeof row>} */ (row).entityId,
                    null
                );
                assert.equal(
                    String(/** @type {NonNullable<typeof row>} */ (row).workspaceId),
                    String(workspaceId)
                );
            });
        });

        test('insertMany honors the entity grants of a narrowed context', async () => {
            await runWithWorkspace(narrowedCtx, async () => {
                await Owned.insertMany([
                    { name: 'bulk-a', entityId: entityA }
                ]);
                await assert.rejects(
                    () =>
                        Owned.insertMany([
                            { name: 'bulk-b', entityId: entityB }
                        ]),
                    (/** @type {unknown} */ err) =>
                        err instanceof Error &&
                        err.name === 'WorkspaceScopeError'
                );
            });
            await runAsSystem('test-verify', async () => {
                assert.equal(await Owned.countDocuments({ name: 'bulk-b' }), 0);
                await Owned.deleteMany({ name: 'bulk-a' });
            });
        });

        test('the owner (all-entities membership) sees rows from both entities', async () => {
            await runWithWorkspace(ownerCtx, async () => {
                assert.equal(await Owned.countDocuments({}), 3);
                assert.notEqual(
                    await Owned.findOne({ _id: ownedB }).lean(),
                    null
                );
                const fileNames = (await FilesLike.find({}).lean()).map(
                    (r) => r.name
                );
                assert.ok(fileNames.includes('file-b'));
            });
        });

        test('runAsSystem bypasses pinning entirely', async () => {
            await runAsSystem('test-verify', async () => {
                const bRows = await Owned.find({
                    workspaceId,
                    entityId: entityB
                }).lean();
                assert.equal(bRows.length, 1);
            });
        });
    });
}
