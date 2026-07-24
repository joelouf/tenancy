# @joelouf/tenancy

A zero-runtime-dependency, fail-closed workspace-tenancy enforcement engine: AsyncLocalStorage tenant context, entity-narrowed Mongoose scope plugins, an enumeration-resistant membership resolver, and lint-guard cores, all behind ports.

Tenant isolation that lives in repository discipline dies by omission: the one forgotten filter is a cross-tenant leak. This engine moves the wall into the machinery itself. A request-scoped context rides Node's AsyncLocalStorage; every scoped query reads it or refuses to run: a missing context is a thrown error, never an unscoped result. On top of the workspace wall sits the entity dimension: memberships may be narrowed to a subset of entities, and narrowed contexts can only see and write inside their grants: grants narrow, never widen. The core is substrate-independent decision logic behind ports; the Mongoose adapter is the enforcement mechanism; everything the engine cannot know (models, connections, role vocabularies, log sinks) is supplied by the host at the composition boundary.

## Features

- **Zero runtime dependencies** - pure JavaScript with node: builtins only; mongoose is an *optional* peer used solely by the `./adapters/mongoose` subpath, so importing the core installs and loads nothing
- **Fail-closed by construction** - no tenant context means every scoped query, aggregation, save, and bulk insert throws `WorkspaceScopeError`; a refused query is always preferred to a leaked one
- **The entity dimension** - per-membership entity grants pin entity-owned reads and writes; null stays visible as the workspace-level state, and narrowed contexts cannot mint misleading nulls where null is not a real state
- **Re-home proof** - update payloads that move, strip, or rename `workspaceId` (or `entityId` from a narrowed context) are rejected across every operator shape: `$set`, `$setOnInsert`, `$unset`, `$rename`, `$min`/`$max`, arithmetic, array ops, and pipeline updates
- **Merge-drop hardened** - the entity pin composes through an explicit `$and`, because mquery's where-merge silently drops an `$in` pin against a bare equality (verified on mongoose 9.6.3)
- **Sanctioned joins only** - `scopedLookup` is the one way to build a `$lookup`: sub-pipelines do not inherit the parent `$match`, and the builder refuses to run before `configureTenancy` names the entity-owned collections (fail closed, never fail open)
- **Enumeration-resistant resolution** - the resolver calls the membership lookup unconditionally, with a null-sentinel workspace id on a slug miss, so "no such workspace" and "not a member" are indistinguishable in query count and timing
- **Audited system bypass** - `runAsSystem` is the only door through the wall; every entry logs the literal provenance line `tenant scope bypass (system context)` through the logger port at a caller-chosen level
- **Split-copy immune** - the ALS, the configuration, and the obligations registry live on `Symbol.for` global stashes, and entity ownership is attached to the schema object itself, so bundler-duplicated module copies share one truth instead of failing open
- **Guard cores included** - the raw-`$lookup`/bypass lint check and the AST plugin-coverage check ship as dependency-injected cores, so a consumer's CI enforces the same discipline this package's CI enforces on itself

## Architecture

```
core/
  types.js               # ObjectIdLike (structural ids), the logger port, the configuration record
  context.js             # The ALS context, WorkspaceScopeError, runWithWorkspace / runAsSystem, the WorkspaceId brand
  config.js              # configureTenancy, the ONE configuration entry (entity-owned collections, logger)
  scope.js               # The filter algebra: readScopeFilter, entityPinFilter, prependScopeMatch
  resolver.js            # createWorkspaceResolver over the TenancyDirectory port; NULL_WORKSPACE_ID
  deletion-obligations.js# The erasure-obligations registry (opaque session, Symbol.for-stashed)
  access-review.js       # Idle/attestation policy math
  invitation-token.js    # CSPRNG token minting and SHA-256 digest custody
grammar/
  index.js               # The scope-selection grammar: dependency-free, client-bundle safe
adapters/
  mongoose/index.js      # tenantFieldsPlugin, workspaceScopePlugin, scopedLookup (the optional peer's only home)
guards/
  index.js               # createWorkspaceScopeCheck + createTenantModelsCheck cores, dependency-injected
```

The core performs no I/O, opens no connection, and holds no per-module ambient state (its three shared stashes are deliberate, documented `Symbol.for` globals: the split-copy defense, pinned by tests). The root export `.` is the core alone; the adapter, the grammar, and the guards are separate subpaths, so a bare import never loads mongoose.

## Install

```bash
npm install @joelouf/tenancy
```

mongoose (`^9.3.3`) is required only if you import `@joelouf/tenancy/adapters/mongoose`.

## Quick Start

### Configure Once, Wall Every Model

```js
import { configureTenancy } from '@joelouf/tenancy';
import {
    tenantFieldsPlugin,
    workspaceScopePlugin
} from '@joelouf/tenancy/adapters/mongoose';
import { Schema, model } from 'mongoose';

// The one configuration entry. The entity-owned list is static, declared by the host;
// scopedLookup refuses to build joins until this has run.
configureTenancy({
    entityOwnedCollections: ['properties', 'leases', 'files'],
    logger: { log: (level, message, fields) => myLogger[level](message, fields) }
});

const propertySchema = new Schema({ addressLine1: String });
propertySchema.plugin(tenantFieldsPlugin, {
    workspaceRef: 'Workspace',   // your model names; the package bakes none in
    entityRef: 'Entity',
    entityOwned: true
});
propertySchema.plugin(workspaceScopePlugin);
export const Property = model('Property', propertySchema);
```

### Resolve a Membership and Run Inside the Wall

```js
import {
    createWorkspaceResolver,
    runWithWorkspace
} from '@joelouf/tenancy';

// The directory port is yours: three reads over your own models, plus an optional
// presence write. listEntityGrants must NOT go through scoped enforcement; it runs
// while the context is still being built (use a native-driver read with both keys explicit).
const resolve = createWorkspaceResolver({
    directory: {
        findActiveWorkspaceBySlug: (slug) =>
            Workspace.findOne({ slug, status: 'active' }).select('_id').lean(),
        findActiveMembership: (userId, workspaceId) =>
            Membership.findOne({ userId, workspaceId, status: 'active' })
                .select('accessRole invitationId lastSeenAt').lean(),
        listEntityGrants: async (workspaceId, membershipId) =>
            (await EntityAccess.collection
                .find({ workspaceId, membershipId }, { projection: { entityId: 1 } })
                .toArray()).map((row) => row.entityId),
        recordLastSeen: (membershipId, staleBefore) =>
            Membership.updateOne(
                { _id: membershipId, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: staleBefore } }] },
                { $set: { lastSeenAt: new Date() } }
            ).exec()
    }
});

const resolution = await resolve({ userId, workspaceSlug: slug });
if (!resolution.ok) {
    // BOTH reasons must map to ONE identical not-found response (same message,
    // same code) or the refusal becomes an existence oracle for workspace slugs.
    throw new NotFoundError('Workspace');
}
await runWithWorkspace(resolution.context, async () => {
    return Property.find({});   // pinned to the workspace (and the entity grants) automatically
});
```

### The Audited Bypass, and the Sanctioned Join

```js
import { runAsSystem } from '@joelouf/tenancy';
import { scopedLookup } from '@joelouf/tenancy/adapters/mongoose';

// Migrations and system jobs only. Every entry logs the provenance line.
await runAsSystem('migration: backfill entity stamps', async () => {
    /* cross-workspace maintenance */
});

// The only sanctioned join: the sub-pipeline carries the workspace guard, and the
// entity pin when the target collection is entity-owned and the context is narrowed.
const pipeline = [
    { $match: { status: 'active' } },
    scopedLookup({ from: 'properties', localField: 'property', foreignField: '_id', as: '_property' })
];
```

### The Client-Safe Grammar

```js
// grammar/ imports NOTHING (no node: builtins, no core), so "use client" bundles can carry it.
import { parseScopeSelection, scopeSelectionToParam } from '@joelouf/tenancy/grammar';

parseScopeSelection('entity:0123456789abcdef01234567'); // { kind: 'entity', id: '…' }
parseScopeSelection('garbage');                          // null; fall back to your default scope
```

## The Enforcement Wall

Every hook reads the ambient context through the fail-closed gate. A system context passes untouched (the audited bypass); a workspace context is enforced; no context throws.

| Interception | What it enforces |
|---|---|
| 12 query middlewares (`find`, `findOne`, `countDocuments`, `distinct`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete`) | Workspace filter injected; entity pin composed via explicit `$and` on entity-owned schemas; update payloads checked for re-home/strip/rename across all operator shapes; pipeline (array-form) updates rejected outright |
| `aggregate` | Workspace `$match` prepended; an existing leading `$match` is trusted only when it pins the *same* workspace, and never by a narrowed context (`alwaysPrepend`); scope can only narrow |
| `validate` (before save) | Missing `workspaceId` stamped from context *before* `required` fires; a foreign one refuses; entity values checked against the grants |
| `insertMany` | Each doc stamped or refused; entity values checked against the grants |

## Refusals

| Attempt (under a workspace context) | Outcome |
|---|---|
| Any scoped operation with no context at all | `WorkspaceScopeError` (code `WORKSPACE_SCOPE_ERROR`) |
| Read another workspace's rows | Filtered out: zero rows, not an error |
| `$set`/`$setOnInsert`/replace payload homing a doc to another workspace | refused |
| `$unset`, `$rename`, `$min`/`$max`, arithmetic or array ops touching `workspaceId` | refused |
| Pipeline (array-form) update | refused |
| Narrowed context reading outside its entity grants | filtered out; caller-supplied `entityId` equalities cannot un-pin (merge-drop hardened) |
| Narrowed context writing an out-of-grant `entityId` | refused |
| Narrowed context writing a null `entityId` where null is not a workspace-level state | refused |
| `scopedLookup` before `configureTenancy` | refused (fail closed) |
| `scopedLookup` with no workspace context | refused |

## The Resolver Contract

| Clause | Behavior |
|---|---|
| Enumeration resistance | `findActiveMembership` is called UNCONDITIONALLY; a slug miss substitutes `NULL_WORKSPACE_ID` (the all-zero id) so both refusal causes issue identical reads. The composition must map both refusal reasons to one identical not-found response. |
| Grants narrow, never widen | Zero grant rows → `entityIds: 'all'`; rows → exactly that list. |
| Presence bookkeeping | `recordLastSeen` is optional, throttled by `lastSeenWriteWindowMs` (default 5 min), fire-and-forget, error-logged through the logger port, and SUPPRESSED under an ambient system context. |
| Invitation provenance | `invited` derives from the membership's `invitationId`. |
| Input custody | `userId` arrives well-formed by contract; the composition validates raw input before calling. |

## Mongoose Version Pins & Coverage Gaps

Behaviors verified on mongoose 9.6.3 and re-verified by this suite on the version CI installs (`^9.3.3`); re-verify on any major bump:

- **where-merge drop**: `query.where()` merging silently drops an `$in` entity pin when the caller's filter carries a bare `entityId` equality; the plugin composes `$and` via `setQuery` instead. The merge-drop attack shape is pinned by a test.
- **Throw-style hooks**: all hooks are Mongoose-9 style, no `next` callback.
- **`updatePipeline`**: Mongoose 9 requires `{ updatePipeline: true }` for array-form updates; the plugin rejects the array form under a workspace context regardless.
- **`pre('insertMany')`** receives the docs array as its first argument.
- **`autoIndex`**: the `schema.index()` calls in `tenantFieldsPlugin` do not self-provision under `autoIndex: false`; index materialization is your deployment's concern.

The wall is query-middleware enforcement, and query middleware has known blind spots; these BYPASS the wall by construction:

- `Model.bulkWrite`
- `estimatedDocumentCount`
- native `.collection.*` access (the resolver's grant read uses exactly this bypass deliberately, host-side)

The recommended layer below is DB-level `$jsonSchema` validators (`required: ["workspaceId"]`, `validationLevel: "strict"`, `validationAction: "error"`) on every tenant collection, which catch native-driver writes; see mre's `scripts/ensure-tenant-validators.ts` for a reference implementation.

## Threat Model & Data Governance

This engine sits on the multi-tenant read/write path, where the failure modes are cross-tenant data exposure, silent scope widening, and unaudited bypass. Each guarantee below is a control against one of those, and each is pinned by a named test.

- **A missing context can never widen a query.** Every hook calls the fail-closed gate; no context is a thrown `WorkspaceScopeError`, not an unscoped result. *Pinned by "find without context rejects rather than returning all rows" and "requireTenantContext throws when none is established (fail-closed)".*
- **Cross-workspace reads and writes are refused, not filtered by convention.** The filter is injected in the plugin, and inserts/saves into a foreign workspace throw. *Pinned by "find in workspace A never returns workspace B rows" and "refuses to insert a document into another workspace".*
- **A document cannot be re-homed across the wall.** Every operator shape that could move, strip, or rename the tenancy key is rejected, including pipeline updates. *Pinned by the "update-bypass shapes" and "operator-payload re-home shapes" suites.*
- **A narrowed membership cannot escape its entity grants.** Reads are pinned (plus null, the workspace-level state), writes outside the grants refuse, and misleading nulls refuse where null is not a real state. *Pinned by the entity-pinning isolation suite, including "a narrowed member cannot create a row stamped to B".*
- **A caller-crafted filter cannot un-pin the entity dimension.** The pin survives mquery's where-merge drop through explicit `$and` composition. *Pinned by "the merge-drop attack shape returns zero rows, not B rows".*
- **A join cannot silently skip the pin.** `scopedLookup` scopes every sub-pipeline and refuses to run unconfigured; the failure mode (an unknown entity-owned list) is a refusal, never a wider join. *Pinned by "scopedLookup BEFORE configureTenancy throws (fail closed, never fail open)".*
- **The bypass is provenance-logged.** `runAsSystem` writes the literal `tenant scope bypass (system context)` line with the caller's reason at a caller-chosen level. *Pinned by "runAsSystem logs the literal provenance line at the default warn level".*
- **Refusals reveal no existence oracle.** The resolver's membership lookup is unconditional with the null-sentinel workspace id, and the port contract requires one uniform not-found mapping. *Pinned by "a missing workspace still calls findActiveMembership, with the null sentinel (enumeration resistance)".*
- **A duplicated module copy cannot fail open.** The ALS, configuration, and obligations registry are `Symbol.for`-stashed; entity ownership rides the schema object itself. Same-realm splits (per-route bundles, symlink realpath splits) share one truth; a vm/edge-realm split would not, which is a recorded limit. *Pinned by the split-copy suite, including "ownership written by one adapter copy is honored by the other".*
- **The test suite itself cannot aim at shared data.** DB-backed cases skip without a configured URI and REFUSE any non-local one. *Pinned by "testDbUri REFUSES a non-local URI instead of running against it".*

## Security

Run the suite and the type-check:

```bash
npm test            # node:test; DB-backed isolation cases run when TENANCY_TEST_DB_URI points at a LOCAL mongod (a non-local URI is refused)
npm run typecheck   # tsc --checkJs, strict (dev-only; not shipped)
```

CI runs the full isolation suite, including the DB-backed leak cases, against a single-node MongoDB replica set on every push and on the release gate. The package also runs its own workspace-scope guard over its shipped source as a test.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## Supply Chain

- **Zero runtime dependencies** - installing this package adds nothing to your dependency tree.
- **No required peer dependencies** - mongoose is an *optional* peer (`^9.3.3`), consulted only when you import `./adapters/mongoose`; core, grammar, and guards run anywhere Node >= 20.19 does (the engines floor follows the mongoose peer's own requirement).
- **Dev toolchain is type-checking and adapter-testing only** - `devDependencies` are `typescript`, `@types/node`, and `mongoose` (the adapter's test/typecheck substrate); none of it ships or installs for consumers. Because the driver tree is audited in CI, `pnpm audit --audit-level high` may occasionally red on an unfixed upstream driver advisory; the policy is to keep the audit step and accept that noise; the published tarball still carries zero runtime dependencies.
- **Deny-by-default packaging** - the published tarball is an explicit `files` allowlist, so only vetted source, declarations, and `SECURITY.md` ship; tests, config, and CI never leave the repository.
- **Reproducible and pinned** - a committed `pnpm-lock.yaml` locks the dev toolchain by integrity hash, the `packageManager` field pins pnpm itself, and CI runs `pnpm install --frozen-lockfile`, the full suite (with the replica-set service), `tsc`, and `pnpm audit` on every push.
- **Verifiable provenance** - releases are published from CI with `pnpm publish --provenance`, attaching a signed Sigstore / SLSA build attestation that ties each tarball to this repository and commit.

## License

MIT
