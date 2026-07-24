/**
 * Access-review policy math: TypeScript Declarations.
 *
 * @module core/access-review
 * @version 1.0.0
 */

export interface AccessReviewCandidate {
    readonly status: string;
    readonly createdAt: string;
    readonly lastSeenAt: string | null;
    readonly accessReviewedAt: string | null;
}

export declare const ACCESS_REVIEW_IDLE_DAYS: number;
export declare const ACCESS_REVIEW_ATTESTATION_FRESH_DAYS: number;

export declare function needsAccessReview(
    member: AccessReviewCandidate,
    now: Date
): boolean;
