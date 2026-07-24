/**
 * The core barrel — the substrate-independent enforcement spine.
 *
 * @module core
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
