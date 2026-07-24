/**
 * The workspace-deletion obligations registry.
 *
 * A provider names something a workspace still owes before it may be erased; the registry is
 * consulted twice on the host's deletion path: once pre-flight for the UI, and once more INSIDE
 * the deletion transaction on its session, so an obligation that lands between the two aborts the
 * erasure rather than dying with it. The session is an opaque type parameter here: the package
 * never touches a driver, and the host re-binds it to its own session type at the composition
 * boundary.
 *
 * It ships EMPTY on purpose: with nothing registered there is nothing to protect, and deletion
 * gates on the host's own confirmations alone.
 *
 * The provider set lives on `globalThis[Symbol.for('@joelouf/tenancy/deletion-obligations')]`,
 * not in module scope. This is the one place a duplicated module copy would fail OPEN: a provider
 * registered through one copy but collected through another would let an erasure proceed past a
 * live obligation exactly where transactional truth is the point. The shared stash makes every
 * same-realm copy read one set.
 *
 * @module core/deletion-obligations
 */

const OBLIGATIONS_KEY = Symbol.for('@joelouf/tenancy/deletion-obligations');

const stash = /** @type {{ [key: symbol]: unknown }} */ (
    /** @type {unknown} */ (globalThis)
);

const providers =
    /** @type {Set<import('./deletion-obligations.js').DeletionObligationProvider<unknown>>} */ (
        stash[OBLIGATIONS_KEY] ??= new Set()
    );

/**
 * Register a provider. Returns an unregister handle so a provider (or a test's ad hoc one) can
 * remove itself without reaching into the registry's internals.
 *
 * @template [TSession=unknown]
 * @param {import('./deletion-obligations.js').DeletionObligationProvider<TSession>} provider
 * @returns {() => void}
 */
export function registerDeletionObligation(provider) {
    const entry =
        /** @type {import('./deletion-obligations.js').DeletionObligationProvider<unknown>} */ (
            provider
        );
    providers.add(entry);
    return () => {
        providers.delete(entry);
    };
}

/**
 * Ask every registered provider what the workspace still owes. Runs the providers sequentially
 * on the caller's session so the answer is transactional truth, not a pre-flight snapshot.
 *
 * @template [TSession=unknown]
 * @param {import('./types.js').ObjectIdLike} workspaceId
 * @param {TSession} session
 * @returns {Promise<import('./deletion-obligations.js').DeletionObligation[]>}
 */
export async function collectDeletionObligations(workspaceId, session) {
    /** @type {import('./deletion-obligations.js').DeletionObligation[]} */
    const obligations = [];
    for (const provider of providers) {
        const descriptions = await provider.collect(workspaceId, session);
        for (const description of descriptions) {
            obligations.push({ provider: provider.name, description });
        }
    }
    return obligations;
}
