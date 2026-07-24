/**
 * The scope-filter algebra — TypeScript Declarations.
 *
 * @module core/scope
 * @version 1.0.0
 */
import type { WorkspaceContext } from './context.js';

export declare function readScopeFilter(
    ctx: WorkspaceContext
): Record<string, unknown>;

export declare function entityPinFilter(
    ctx: WorkspaceContext
): Record<string, unknown> | null;

export declare function scopeMatchStage(filter: Record<string, unknown>): {
    $match: Record<string, unknown>;
};

export declare function prependScopeMatch(
    pipeline: object[],
    filter: Record<string, unknown>,
    options?: { alwaysPrepend?: boolean }
): void;
