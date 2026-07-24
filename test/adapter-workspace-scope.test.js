// The adapter wall suite — the machinery-generic port of the consumer's workspace-scope pins,
// on probe schemas. The no-DB half always runs (the fail-closed wiring needs no connection);
// the DB-backed half runs against a LOCAL mongod only: unset TENANCY_TEST_DB_URI skips it
// cleanly, a non-local value makes the harness throw (fail closed).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose, { Schema, Types } from 'mongoose';
import {
    WorkspaceScopeError,
    runAsSystem,
    runWithWorkspace
} from '../index.js';
import {
    tenantFieldsPlugin,
    workspaceScopePlugin
} from '../adapters/mongoose/index.js';
import {
    workspaceContext,
    expectScopeRefusal,
    testDbUri,
    DB_SKIP_REASON
} from './_harness.js';

const DB_URI = testDbUri();

mongoose.set('bufferCommands', false);

const userId = new Types.ObjectId();
const wsA = new Types.ObjectId();
const wsB = new Types.ObjectId();

/** @param {Partial<import('../core/context.js').WorkspaceContext>} [over] */
const wctx = (over = {}) =>
    workspaceContext({ userId, workspaceId: wsA, ...over });

/**
 * @param {string} modelName
 * @param {string} collection
 * @param {Record<string, unknown>} [extraPaths]
 */
const probeModel = (modelName, collection, extraPaths = {}) => {
    const schema = new Schema({ name: String, ...extraPaths });
    tenantFieldsPlugin(schema, { workspaceRef: 'WsProbeWorkspace' });
    workspaceScopePlugin(schema);
    return (
        mongoose.models[modelName] ??
        mongoose.model(modelName, schema, collection)
    );
};

describe('plugin fail-closed wiring (no DB needed)', () => {
    const Probe = probeModel('ScopeProbe', 'scope_probe');

    test('find without context rejects rather than returning all rows', async () => {
        await expectScopeRefusal(
            () => Probe.find({}).exec(),
            /No tenant context/
        );
    });

    test('aggregate without context rejects', async () => {
        await expectScopeRefusal(() => Probe.aggregate([]).exec());
    });

    test('refuses to attach to a schema without a workspaceId path', () => {
        const bad = new Schema({ name: String });
        assert.throws(
            () => bad.plugin(workspaceScopePlugin),
            /requires a `workspaceId` path/
        );
    });

    test('tenantFieldsPlugin demands its ref options', () => {
        const schema = new Schema({ name: String });
        assert.throws(
            () =>
                tenantFieldsPlugin(
                    schema,
                    /** @type {never} */ (undefined)
                ),
            /workspaceRef/
        );
        assert.throws(
            () =>
                tenantFieldsPlugin(schema, {
                    workspaceRef: 'Workspace',
                    entityOwned: true
                }),
            /entityRef/
        );
    });

    test('validate stamps the context workspaceId before required fires (no connection involved)', async () => {
        await runWithWorkspace(wctx(), async () => {
            const doc = new Probe({ name: 'stamp-me' });
            await doc.validate();
            assert.equal(String(doc.get('workspaceId')), String(wsA));
        });
    });

    test('validate refuses a document homed to a foreign workspace', async () => {
        await runWithWorkspace(wctx(), async () => {
            const doc = new Probe({ name: 'foreign', workspaceId: wsB });
            await expectScopeRefusal(
                () => doc.validate(),
                /across the workspace boundary/
            );
        });
    });
});

if (!DB_URI) {
    test('cross-workspace isolation over a live mongod', { skip: DB_SKIP_REASON }, () => {});
} else {
    describe('cross-workspace isolation (local test DB)', () => {
        const Doc = probeModel('ScopeProbeDb', 'scope_probe_db');
        const OpsDoc = probeModel('ScopeProbeOps', 'scope_probe_ops', {
            count: Number
        });
        const ImDoc = probeModel(
            'ScopeProbeInsertMany',
            'scope_probe_insertmany'
        );

        before(async () => {
            await mongoose.connect(DB_URI);
            await runAsSystem('test-seed', async () => {
                await Doc.deleteMany({});
                await OpsDoc.deleteMany({});
                await ImDoc.deleteMany({});
            });
            await runWithWorkspace(wctx(), async () => {
                await Doc.create({ name: 'a1' });
                await Doc.create({ name: 'a2' });
            });
            await runWithWorkspace(wctx({ workspaceId: wsB }), async () => {
                await Doc.create({ name: 'b1' });
            });
        });

        after(async () => {
            await runAsSystem('test-teardown', async () => {
                await Doc.deleteMany({});
                await OpsDoc.deleteMany({});
                await ImDoc.deleteMany({});
            });
            await mongoose.disconnect();
        });

        test('save stamps the current workspaceId', async () => {
            await runWithWorkspace(wctx(), async () => {
                const docs = await Doc.find({}).lean();
                assert.ok(docs.length > 0);
                for (const d of docs) {
                    assert.equal(String(d.workspaceId), String(wsA));
                }
            });
        });

        test('find in workspace A never returns workspace B rows', async () => {
            await runWithWorkspace(wctx(), async () => {
                const names = (await Doc.find({}).lean())
                    .map((d) => d.name)
                    .sort();
                assert.deepEqual(names, ['a1', 'a2']);
            });
        });

        test('aggregate in workspace B never returns workspace A rows', async () => {
            await runWithWorkspace(wctx({ workspaceId: wsB }), async () => {
                const rows = await Doc.aggregate([{ $project: { name: 1 } }]);
                assert.deepEqual(
                    rows.map((r) => r.name),
                    ['b1']
                );
            });
        });

        test('refuses to insert a document into another workspace', async () => {
            await runWithWorkspace(wctx(), async () => {
                const doc = new Doc({ name: 'x', workspaceId: wsB });
                await expectScopeRefusal(() => doc.save());
            });
        });

        test('system context can read across workspaces (audited escape hatch)', async () => {
            await runAsSystem('test-readall', async () => {
                assert.equal(await Doc.countDocuments({}), 3);
            });
        });

        test('refuses an update payload that re-homes a doc to another workspace', async () => {
            await runWithWorkspace(wctx(), async () => {
                const target = await Doc.findOne({ name: 'a1' });
                assert.notEqual(target, null);
                await expectScopeRefusal(() =>
                    Doc.updateOne(
                        { _id: /** @type {NonNullable<typeof target>} */ (target)._id },
                        { $set: { workspaceId: wsB } }
                    ).exec()
                );
            });
            await runAsSystem('test-verify', async () => {
                const still = await Doc.findOne({ name: 'a1' }).lean();
                assert.equal(
                    String(/** @type {NonNullable<typeof still>} */ (still).workspaceId),
                    String(wsA)
                );
            });
        });

        test('allows an ordinary update that does not touch tenancy keys', async () => {
            await runWithWorkspace(wctx(), async () => {
                await Doc.updateOne(
                    { name: 'a2' },
                    { $set: { name: 'a2-renamed' } }
                );
                const renamed = await Doc.findOne({ name: 'a2-renamed' });
                assert.notEqual(renamed, null);
            });
        });

        describe('update-bypass shapes (pipeline / $unset / $rename)', () => {
            test('refuses a pipeline (array-form) update that re-homes an in-scope doc', async () => {
                /** @type {Types.ObjectId | undefined} */
                let id;
                await runWithWorkspace(wctx(), async () => {
                    const seed = await Doc.create({ name: 'pipe-rehome' });
                    id = /** @type {Types.ObjectId} */ (seed._id);
                    await expectScopeRefusal(
                        () =>
                            Doc.updateOne(
                                { _id: id },
                                [{ $set: { workspaceId: wsB } }],
                                { updatePipeline: true }
                            ).exec(),
                        /pipeline update/
                    );
                });
                await runAsSystem('test-verify', async () => {
                    const still = await Doc.findById(id).lean();
                    assert.equal(
                        String(/** @type {NonNullable<typeof still>} */ (still).workspaceId),
                        String(wsA)
                    );
                });
            });

            test('refuses a pipeline update via updateMany', async () => {
                await runWithWorkspace(wctx(), async () => {
                    await Doc.create({ name: 'pipe-many' });
                    await expectScopeRefusal(() =>
                        Doc.updateMany(
                            { name: 'pipe-many' },
                            [{ $set: { workspaceId: wsB } }],
                            { updatePipeline: true }
                        ).exec()
                    );
                });
            });

            test('refuses a pipeline update via findOneAndUpdate', async () => {
                await runWithWorkspace(wctx(), async () => {
                    await Doc.create({ name: 'pipe-foau' });
                    await expectScopeRefusal(() =>
                        Doc.findOneAndUpdate(
                            { name: 'pipe-foau' },
                            [{ $set: { workspaceId: wsB } }],
                            { updatePipeline: true }
                        ).exec()
                    );
                });
            });

            test('refuses a $unset that strips workspaceId off an in-scope doc', async () => {
                /** @type {Types.ObjectId | undefined} */
                let id;
                await runWithWorkspace(wctx(), async () => {
                    const seed = await Doc.create({ name: 'unset-ws' });
                    id = /** @type {Types.ObjectId} */ (seed._id);
                    await expectScopeRefusal(
                        () =>
                            Doc.updateOne(
                                { _id: id },
                                { $unset: { workspaceId: '' } }
                            ).exec(),
                        /strip a tenancy key/
                    );
                });
                await runAsSystem('test-verify', async () => {
                    const still = await Doc.findById(id).lean();
                    assert.equal(
                        String(/** @type {NonNullable<typeof still>} */ (still).workspaceId),
                        String(wsA)
                    );
                });
            });

            test('refuses a $rename that moves workspaceId off an in-scope doc', async () => {
                /** @type {Types.ObjectId | undefined} */
                let id;
                await runWithWorkspace(wctx(), async () => {
                    const seed = await Doc.create({ name: 'rename-ws' });
                    id = /** @type {Types.ObjectId} */ (seed._id);
                    await expectScopeRefusal(
                        () =>
                            Doc.updateOne(
                                { _id: id },
                                { $rename: { workspaceId: 'oldWs' } }
                            ).exec(),
                        /rename a tenancy key/
                    );
                });
                await runAsSystem('test-verify', async () => {
                    const still = await Doc.findById(id).lean();
                    assert.equal(
                        String(/** @type {NonNullable<typeof still>} */ (still).workspaceId),
                        String(wsA)
                    );
                });
            });

            test('refuses a $rename whose target key is workspaceId', async () => {
                await runWithWorkspace(wctx(), async () => {
                    await Doc.create({ name: 'rename-into-ws' });
                    await expectScopeRefusal(() =>
                        Doc.updateOne(
                            { name: 'rename-into-ws' },
                            { $rename: { name: 'workspaceId' } }
                        ).exec()
                    );
                });
            });

            test('lets a system-context pipeline update through (bypass intact)', async () => {
                /** @type {Types.ObjectId | undefined} */
                let id;
                await runAsSystem('test-sys-pipe', async () => {
                    const seed = await Doc.create({
                        name: 'sys-pipe',
                        workspaceId: wsA
                    });
                    id = /** @type {Types.ObjectId} */ (seed._id);
                    await Doc.updateOne(
                        { _id: id },
                        [{ $set: { name: 'sys-pipe-done' } }],
                        { updatePipeline: true }
                    );
                    const updated = await Doc.findById(id).lean();
                    assert.equal(
                        /** @type {NonNullable<typeof updated>} */ (updated).name,
                        'sys-pipe-done'
                    );
                });
            });
        });

        describe('operator-payload re-home shapes ($min / $max / $inc-class)', () => {
            const higherForeignWs = new Types.ObjectId(
                'ffffffffffffffffffffffff'
            );
            const lowerForeignWs = new Types.ObjectId(
                '000000000000000000000000'
            );

            test('refuses a $max that re-homes workspaceId to a higher foreign id, leaving the doc unchanged', async () => {
                /** @type {Types.ObjectId | undefined} */
                let id;
                await runWithWorkspace(wctx(), async () => {
                    const seed = await OpsDoc.create({ name: 'max-rehome' });
                    id = /** @type {Types.ObjectId} */ (seed._id);
                    await expectScopeRefusal(
                        () =>
                            OpsDoc.updateOne(
                                { _id: id },
                                { $max: { workspaceId: higherForeignWs } }
                            ).exec(),
                        /update operator that mutates a tenancy key/
                    );
                });
                await runAsSystem('test-verify', async () => {
                    const still = await OpsDoc.findById(id).lean();
                    assert.equal(
                        String(/** @type {NonNullable<typeof still>} */ (still).workspaceId),
                        String(wsA)
                    );
                });
            });

            test('refuses a $min that re-homes workspaceId to a lower foreign id', async () => {
                /** @type {Types.ObjectId | undefined} */
                let id;
                await runWithWorkspace(wctx(), async () => {
                    const seed = await OpsDoc.create({ name: 'min-rehome' });
                    id = /** @type {Types.ObjectId} */ (seed._id);
                    await expectScopeRefusal(() =>
                        OpsDoc.updateOne(
                            { _id: id },
                            { $min: { workspaceId: lowerForeignWs } }
                        ).exec()
                    );
                });
                await runAsSystem('test-verify', async () => {
                    const still = await OpsDoc.findById(id).lean();
                    assert.equal(
                        String(/** @type {NonNullable<typeof still>} */ (still).workspaceId),
                        String(wsA)
                    );
                });
            });

            test('allows ordinary $inc and $max on non-tenancy fields', async () => {
                await runWithWorkspace(wctx(), async () => {
                    const seed = await OpsDoc.create({
                        name: 'arith-ok',
                        count: 1
                    });
                    await OpsDoc.updateOne(
                        { _id: seed._id },
                        { $inc: { count: 2 } }
                    ).exec();
                    await OpsDoc.updateOne(
                        { _id: seed._id },
                        { $max: { count: 100 } }
                    ).exec();
                    const updated = await OpsDoc.findById(seed._id).lean();
                    assert.equal(
                        /** @type {NonNullable<typeof updated>} */ (updated).count,
                        100
                    );
                    assert.equal(
                        String(/** @type {NonNullable<typeof updated>} */ (updated).workspaceId),
                        String(wsA)
                    );
                });
            });
        });

        describe('insertMany enforcement', () => {
            test('stamps the current workspaceId on a plain valid bulk insert', async () => {
                await runWithWorkspace(wctx(), async () => {
                    await ImDoc.insertMany([{ name: 'im1' }, { name: 'im2' }]);
                    const rows = await ImDoc.find({}).lean();
                    assert.deepEqual(
                        rows.map((r) => r.name).sort(),
                        ['im1', 'im2']
                    );
                    for (const row of rows) {
                        assert.equal(String(row.workspaceId), String(wsA));
                    }
                });
            });

            test('refuses a bulk insert carrying a foreign workspaceId', async () => {
                await runWithWorkspace(wctx(), async () => {
                    await assert.rejects(
                        () =>
                            ImDoc.insertMany([
                                { name: 'im3', workspaceId: wsB }
                            ]),
                        WorkspaceScopeError
                    );
                });
                await runAsSystem('test-verify', async () => {
                    assert.equal(
                        await ImDoc.countDocuments({ name: 'im3' }),
                        0
                    );
                });
            });

            test('bypasses under a system context and preserves explicit workspaceIds', async () => {
                await runAsSystem('test-bulk', async () => {
                    await ImDoc.insertMany([
                        { name: 'im-sys', workspaceId: wsB }
                    ]);
                    const row = await ImDoc.findOne({ name: 'im-sys' }).lean();
                    assert.equal(
                        String(/** @type {NonNullable<typeof row>} */ (row).workspaceId),
                        String(wsB)
                    );
                });
            });
        });
    });
}
