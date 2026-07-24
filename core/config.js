/**
 * The one-time tenancy configuration — the single entry point where the host application tells
 * the engine what it cannot know on its own: which collections are entity-owned, and where to
 * log.
 *
 * The configured state lives on `globalThis[Symbol.for('@joelouf/tenancy/configuration')]`, not
 * in module scope. Bundlers and linkers can duplicate this module (per-route server bundles,
 * symlink realpath splits); a module-scoped record would let one copy be configured while another
 * silently reports "unconfigured", and the consumers of the entity-owned list fail CLOSED on
 * unconfigured — so a split would turn into an outage or, worse, tempt a fail-open fallback.
 * `Symbol.for` is process-wide within a realm, so every same-realm copy reads one record. A vm or
 * edge-realm split would not share it; that is a recorded limit, not a covered case.
 *
 * @module core/config
 */

const CONFIGURATION_KEY = Symbol.for('@joelouf/tenancy/configuration');

/**
 * @typedef {object} ConfigurationState
 * @property {readonly string[] | null} entityOwnedCollections
 * @property {import('./types.js').LoggerPort | null} logger
 */

const stash = /** @type {{ [key: symbol]: unknown }} */ (
    /** @type {unknown} */ (globalThis)
);

const state = /** @type {ConfigurationState} */ (
    (stash[CONFIGURATION_KEY] ??= {
        entityOwnedCollections: null,
        logger: null
    })
);

/**
 * Configure the engine. Merge semantics, deliberately: each provided key overwrites only itself,
 * so the composition module that owns the entity-owned list and the one that owns the logger can
 * each call this without clobbering the other. Calling again with the same key replaces that
 * key's value (last write wins).
 *
 * @param {import('./types.js').TenancyConfiguration} configuration
 * @returns {void}
 */
export function configureTenancy(configuration) {
    if (configuration.entityOwnedCollections !== undefined) {
        state.entityOwnedCollections = Object.freeze(
            configuration.entityOwnedCollections.map(String)
        );
    }
    if (configuration.logger !== undefined) {
        state.logger = configuration.logger ?? null;
    }
}

/**
 * The configured entity-owned collection list, or null when configuration has not happened.
 * Consumers that need the list MUST treat null as a refusal, never as an empty list: an empty
 * list means "no collection is entity-owned" (a valid statement), while null means "nobody has
 * said" (fail closed).
 *
 * @returns {readonly string[] | null}
 */
export function configuredEntityOwnedCollections() {
    return state.entityOwnedCollections;
}

/**
 * The configured logger port, or null for silence.
 *
 * @returns {import('./types.js').LoggerPort | null}
 */
export function configuredLogger() {
    return state.logger;
}
