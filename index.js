/**
 * @joelouf/tenancy
 *
 * A zero-runtime-dependency, fail-closed workspace-tenancy enforcement engine. The core carries
 * the tenant context on AsyncLocalStorage, builds the scope-filter algebra, and resolves
 * memberships through ports; the Mongoose enforcement adapter, the client-safe scope grammar,
 * and the lint-guard cores live behind their own subpath exports.
 *
 * The root export is deliberately the core ONLY. Re-exporting the adapter here would make a
 * bare `import '@joelouf/tenancy'` load mongoose, breaking the optional-peer confinement. Import
 * '@joelouf/tenancy/adapters/mongoose' for the plugins, '@joelouf/tenancy/grammar' for the
 * client-safe scope grammar, and '@joelouf/tenancy/guards' for the checker cores.
 *
 * @module @joelouf/tenancy
 */

export * from './core/index.js';
