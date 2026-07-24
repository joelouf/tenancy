import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WorkspaceScopeError,
    isWorkspaceScopeError,
    getTenantContext,
    requireTenantContext,
    requireWorkspaceContext,
    requireRowWorkspaceId,
    workspaceIdOf,
    requireWorkspaceId,
    runWithWorkspace,
    runAsSystem,
    configureTenancy
} from '../index.js';
import { oid, workspaceContext, recordingLogger } from './_harness.js';

test('has no context outside a run', () => {
    assert.equal(getTenantContext(), undefined);
});

test('requireTenantContext throws when none is established (fail-closed)', () => {
    assert.throws(() => requireTenantContext(), WorkspaceScopeError);
});

test('the fail-closed refusal carries the stable code and the guard narrows it', () => {
    try {
        requireTenantContext();
        assert.fail('expected a throw');
    } catch (err) {
        assert.ok(isWorkspaceScopeError(err));
        const error = /** @type {WorkspaceScopeError} */ (err);
        assert.equal(error.code, 'WORKSPACE_SCOPE_ERROR');
        assert.equal(error.name, 'WorkspaceScopeError');
    }
});

test('runWithWorkspace establishes a workspace context', async () => {
    const ctx = workspaceContext({ slug: 'w-establish' });
    await runWithWorkspace(ctx, async () => {
        const current = requireWorkspaceContext();
        assert.equal(current.kind, 'workspace');
        assert.equal(String(current.workspaceId), String(ctx.workspaceId));
        assert.equal(current.slug, 'w-establish');
        assert.equal(current.invited, false);
    });
});

test('runAsSystem establishes a system context that requireWorkspaceContext rejects', async () => {
    await runAsSystem('test', async () => {
        assert.equal(requireTenantContext().kind, 'system');
        assert.throws(() => requireWorkspaceContext(), WorkspaceScopeError);
    });
});

test('context does not leak across runs', async () => {
    const ctx = workspaceContext({ accessRole: 'viewer' });
    await runWithWorkspace(ctx, async () => {
        assert.equal(
            String(requireWorkspaceContext().workspaceId),
            String(ctx.workspaceId)
        );
    });
    assert.equal(getTenantContext(), undefined);
});

test('nested runs are independent: the inner context wins and the outer returns', async () => {
    const outer = workspaceContext({ slug: 'w-outer' });
    const inner = workspaceContext({ slug: 'w-inner' });
    await runWithWorkspace(outer, async () => {
        await runWithWorkspace(inner, async () => {
            assert.equal(requireWorkspaceContext().slug, 'w-inner');
        });
        assert.equal(requireWorkspaceContext().slug, 'w-outer');
    });
});

test('runAsSystem logs the literal provenance line at the default warn level', async () => {
    const logger = recordingLogger();
    configureTenancy({ logger });
    try {
        await runAsSystem('test-default-level', async () => {
            assert.equal(requireTenantContext().kind, 'system');
        });
        assert.equal(logger.entries.length, 1);
        assert.equal(logger.entries[0].level, 'warn');
        assert.equal(
            logger.entries[0].message,
            'tenant scope bypass (system context)'
        );
        assert.deepEqual(logger.entries[0].fields, {
            reason: 'test-default-level'
        });
    } finally {
        configureTenancy({ logger: null });
    }
});

test('runAsSystem logs at an overridden level while still establishing a system context', async () => {
    const logger = recordingLogger();
    configureTenancy({ logger });
    try {
        await runAsSystem(
            'test-quiet',
            async () => {
                assert.equal(requireTenantContext().kind, 'system');
            },
            { level: 'info' }
        );
        assert.ok(
            logger.entries.some(
                (entry) =>
                    entry.level === 'info' &&
                    entry.message.includes('tenant scope bypass')
            )
        );
        assert.ok(!logger.entries.some((entry) => entry.level === 'warn'));
    } finally {
        configureTenancy({ logger: null });
    }
});

test('runAsSystem stays silent when no logger port is configured', async () => {
    await runAsSystem('test-silent', async () => {
        assert.equal(requireTenantContext().kind, 'system');
    });
});

test('requireRowWorkspaceId returns the row workspace as a brand and refuses a missing one', () => {
    const workspaceId = oid();
    assert.equal(
        requireRowWorkspaceId({ workspaceId }, 'Probe'),
        workspaceId.toString()
    );
    assert.throws(
        () => requireRowWorkspaceId({}, 'Probe'),
        (err) =>
            isWorkspaceScopeError(err) &&
            /Probe has no workspaceId/.test(/** @type {Error} */ (err).message)
    );
    assert.throws(
        () => requireRowWorkspaceId({ workspaceId: null }, 'Probe'),
        WorkspaceScopeError
    );
});

test('workspaceIdOf and requireWorkspaceId derive the context workspace as a brand', async () => {
    const ctx = workspaceContext();
    await runWithWorkspace(ctx, async () => {
        const current = requireWorkspaceContext();
        assert.equal(workspaceIdOf(current), ctx.workspaceId.toString());
        assert.equal(requireWorkspaceId(), ctx.workspaceId.toString());
    });
    assert.throws(() => requireWorkspaceId(), WorkspaceScopeError);
});

test('requireWorkspaceId under a system context refuses (a system flow has no one workspace)', async () => {
    await runAsSystem('test-brand', async () => {
        assert.throws(() => requireWorkspaceId(), WorkspaceScopeError);
    });
});
