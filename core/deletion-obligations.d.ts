/**
 * The workspace-deletion obligations registry — TypeScript Declarations.
 *
 * @module core/deletion-obligations
 * @version 1.0.0
 */
import type { ObjectIdLike } from './types.js';

export interface DeletionObligation {
    readonly provider: string;
    readonly description: string;
}

export interface DeletionObligationProvider<TSession = unknown> {
    readonly name: string;
    /**
     * Everything this provider still requires of the workspace, described in user-facing terms.
     * An empty array means no objection. Runs on the deletion transaction's session so the
     * answer is transactional truth, not a pre-flight snapshot.
     */
    collect(workspaceId: ObjectIdLike, session: TSession): Promise<string[]>;
}

export declare function registerDeletionObligation<TSession = unknown>(
    provider: DeletionObligationProvider<TSession>
): () => void;

export declare function collectDeletionObligations<TSession = unknown>(
    workspaceId: ObjectIdLike,
    session: TSession
): Promise<DeletionObligation[]>;
