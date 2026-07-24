/**
 * Shared test harness: id stubs, context builders, a recording logger, an in-memory directory,
 * and the fail-closed test-DB gate.
 *
 * DB posture: DB-backed cases read TENANCY_TEST_DB_URI. When it is unset they skip cleanly; when
 * it is set to anything non-local the harness THROWS at load (fail closed); the suite must
 * never be able to point at a shared database, even by inherited environment.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isWorkspaceScopeError } from '../index.js';

/**
 * A mongoose-free ObjectIdLike over a fixed 24-hex string, so core tests never need a driver.
 *
 * @param {string} [hex]
 * @returns {import('../core/types.js').ObjectIdLike}
 */
export const oid = (hex = randomBytes(12).toString('hex')) =>
    Object.freeze({
        toHexString: () => hex,
        toString: () => hex,
        /** @param {unknown} other */
        equals: (other) => String(other) === hex
    });

/**
 * A complete workspace context literal (including the required `invited` field) with overrides.
 *
 * @param {Partial<Omit<import('../core/context.js').WorkspaceContext, 'kind'>>} [over]
 * @returns {Omit<import('../core/context.js').WorkspaceContext, 'kind'>}
 */
export const workspaceContext = (over = {}) => ({
    userId: oid(),
    workspaceId: oid(),
    slug: 'w-test',
    accessRole: 'owner_admin',
    entityIds: 'all',
    invited: false,
    ...over
});

/**
 * @typedef {{ level: import('../core/types.js').LogLevel, message: string, fields: Record<string, unknown> | undefined }} LogEntry
 */

/**
 * A logger port that records every line it is handed.
 *
 * @returns {{ entries: LogEntry[], log: import('../core/types.js').LoggerPort['log'] }}
 */
export const recordingLogger = () => {
    /** @type {LogEntry[]} */
    const entries = [];
    return {
        entries,
        log(level, message, fields) {
            entries.push({ level, message, fields });
        }
    };
};

/**
 * An in-memory TenancyDirectory over plain rows, recording every call it receives.
 *
 * @param {{
 *     workspaces?: { _id: import('../core/types.js').ObjectIdLike, slug: string }[],
 *     memberships?: (import('../core/resolver.js').DirectoryMembership & {
 *         userId: import('../core/types.js').ObjectIdLike,
 *         workspaceId: import('../core/types.js').ObjectIdLike
 *     })[],
 *     grants?: { workspaceId: import('../core/types.js').ObjectIdLike,
 *         membershipId: import('../core/types.js').ObjectIdLike,
 *         entityId: import('../core/types.js').ObjectIdLike }[],
 *     recordLastSeen?: (membershipId: import('../core/types.js').ObjectIdLike, staleBefore: Date) => void | Promise<unknown>
 * }} [seed]
 */
export const memoryDirectory = (seed = {}) => {
    const workspaces = seed.workspaces ?? [];
    const memberships = seed.memberships ?? [];
    const grants = seed.grants ?? [];
    /** @type {{ method: string, args: unknown[] }[]} */
    const calls = [];

    /** @type {import('../core/resolver.js').TenancyDirectory & { calls: { method: string, args: unknown[] }[] }} */
    const directory = {
        calls,
        async findActiveWorkspaceBySlug(slug) {
            calls.push({ method: 'findActiveWorkspaceBySlug', args: [slug] });
            const row = workspaces.find((w) => w.slug === slug);
            return row ? { _id: row._id } : null;
        },
        async findActiveMembership(userId, workspaceId) {
            calls.push({
                method: 'findActiveMembership',
                args: [userId, workspaceId]
            });
            const row = memberships.find(
                (m) =>
                    String(m.userId) === String(userId) &&
                    String(m.workspaceId) === String(workspaceId)
            );
            return row ?? null;
        },
        async listEntityGrants(workspaceId, membershipId) {
            calls.push({
                method: 'listEntityGrants',
                args: [workspaceId, membershipId]
            });
            return grants
                .filter(
                    (g) =>
                        String(g.workspaceId) === String(workspaceId) &&
                        String(g.membershipId) === String(membershipId)
                )
                .map((g) => g.entityId);
        }
    };
    if (seed.recordLastSeen) {
        const record = seed.recordLastSeen;
        directory.recordLastSeen = (membershipId, staleBefore) => {
            calls.push({
                method: 'recordLastSeen',
                args: [membershipId, staleBefore]
            });
            return record(membershipId, staleBefore);
        };
    }
    return directory;
};

/**
 * Assert `fn` rejects with a WorkspaceScopeError (checked by the package's own guard, so class
 * identity and the stable code are both exercised).
 *
 * @param {() => Promise<unknown>} fn
 * @param {RegExp} [messagePattern]
 * @returns {Promise<void>}
 */
export const expectScopeRefusal = (fn, messagePattern) =>
    assert.rejects(fn, (err) => {
        assert.ok(
            isWorkspaceScopeError(err),
            `expected WorkspaceScopeError, got ${String(err)}`
        );
        const error = /** @type {import('../index.js').WorkspaceScopeError} */ (
            err
        );
        assert.equal(error.code, 'WORKSPACE_SCOPE_ERROR');
        if (messagePattern) assert.match(error.message, messagePattern);
        return true;
    });

/**
 * @param {string} hostPort
 * @returns {boolean}
 */
const isLocalHost = (hostPort) => {
    const host = hostPort.trim();
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end > 0 && host.slice(1, end) === '::1';
    }
    const name = host.split(':')[0];
    return name === 'localhost' || name === '127.0.0.1';
};

/**
 * Whether a Mongo URI points only at local hosts (the mre testEnv.ts discipline).
 *
 * @param {string} uri
 * @returns {boolean}
 */
export const isLocalMongoUri = (uri) => {
    if (!uri.startsWith('mongodb://')) return false;
    const authority = uri.slice('mongodb://'.length).split(/[/?]/)[0];
    const lastAt = authority.lastIndexOf('@');
    const hostSection = lastAt >= 0 ? authority.slice(lastAt + 1) : authority;
    if (hostSection === '') return false;
    return hostSection.split(',').every(isLocalHost);
};

/**
 * The test database URI, or null when DB-backed cases should skip. REFUSES (throws) any
 * non-local URI: fail closed, never "gate on one".
 *
 * @returns {string | null}
 */
export const testDbUri = () => {
    const uri = process.env.TENANCY_TEST_DB_URI;
    if (!uri) return null;
    if (!isLocalMongoUri(uri)) {
        throw new Error(
            '[test-safety] Refusing to run DB-backed tests against a non-local TENANCY_TEST_DB_URI ' +
                `(${uri.replace(/\/\/[^@]*@/, '//***:***@')}). ` +
                'Tests only run against a local mongod. Unset it or point it at localhost/127.0.0.1.'
        );
    }
    return uri;
};

/** The skip annotation for DB-backed suites when no local test DB is configured. */
export const DB_SKIP_REASON =
    'TENANCY_TEST_DB_URI is not set; DB-backed cases skipped';

/**
 * Import the module at `relativePath` (relative to the package root) as a FRESH instance by
 * appending a unique query string; Node keys ESM module instances by resolved URL, so distinct
 * queries execute the module body again and yield genuinely separate copies in one realm. The
 * split-copy suite uses this to simulate bundler/symlink duplication.
 *
 * @param {string} relativePath
 * @param {string} copyTag
 * @returns {Promise<unknown>}
 */
export const importFreshCopy = (relativePath, copyTag) =>
    import(
        new URL(`../${relativePath}?copy=${copyTag}`, import.meta.url).href
    );
