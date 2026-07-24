/**
 * The core barrel: TypeScript Declarations.
 *
 * @module core
 * @version 1.0.1
 */

// Context and the fail-closed gate.
export {
    WorkspaceScopeError,
    isWorkspaceScopeError,
    getTenantContext,
    requireTenantContext,
    requireWorkspaceContext,
    requireRowWorkspaceId,
    workspaceIdOf,
    requireWorkspaceId,
    runWithWorkspace,
    runAsSystem
} from './context.js';

// Configuration.
export {
    configureTenancy,
    configuredEntityOwnedCollections,
    configuredLogger
} from './config.js';

// The scope-filter algebra.
export {
    readScopeFilter,
    entityPinFilter,
    scopeMatchStage,
    prependScopeMatch
} from './scope.js';

// The workspace resolver.
export {
    LAST_SEEN_WRITE_WINDOW_MS,
    NULL_WORKSPACE_ID,
    createWorkspaceResolver
} from './resolver.js';

// Deletion obligations.
export {
    registerDeletionObligation,
    collectDeletionObligations
} from './deletion-obligations.js';

// Access-review policy math.
export {
    ACCESS_REVIEW_IDLE_DAYS,
    ACCESS_REVIEW_ATTESTATION_FRESH_DAYS,
    needsAccessReview
} from './access-review.js';

// Invitation token custody.
export {
    generateInvitationToken,
    hashInvitationToken
} from './invitation-token.js';

// Shared structural types.
export type {
    ObjectIdLike,
    LogLevel,
    LoggerPort,
    TenancyConfiguration
} from './types.js';

// Context types.
export type {
    WorkspaceContext,
    SystemContext,
    TenantContext,
    WorkspaceId,
    RunAsSystemOptions
} from './context.js';

// Resolver types.
export type {
    DirectoryWorkspace,
    DirectoryMembership,
    TenancyDirectory,
    WorkspaceResolverDeps,
    ResolveWorkspaceParams,
    WorkspaceRefusalReason,
    WorkspaceResolution,
    WorkspaceResolver
} from './resolver.js';

// Deletion-obligation types.
export type {
    DeletionObligation,
    DeletionObligationProvider
} from './deletion-obligations.js';

// Access-review types.
export type { AccessReviewCandidate } from './access-review.js';
