/**
 * Access-review policy math — when a membership is due for an access attestation.
 *
 * Pure date arithmetic: a member is due when they have been idle past the idle window AND their
 * last attestation (if any) has gone stale. Non-active memberships are never due — they are
 * already out of the tenant.
 *
 * @module core/access-review
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days of inactivity after which a membership becomes an access-review candidate. */
export const ACCESS_REVIEW_IDLE_DAYS = 60;

/** Days an access attestation stays fresh; older attestations no longer excuse an idle member. */
export const ACCESS_REVIEW_ATTESTATION_FRESH_DAYS = 90;

/**
 * Whether the member needs an access review as of `now`. The idle anchor is the last seen time,
 * falling back to the membership's creation; an unparseable anchor is never due (garbage in, no
 * alarm out), while an unparseable attestation IS due (a corrupt attestation excuses nothing).
 *
 * @param {import('./access-review.js').AccessReviewCandidate} member
 * @param {Date} now
 * @returns {boolean}
 */
export function needsAccessReview(member, now) {
    if (member.status !== 'active') return false;

    const anchor = new Date(member.lastSeenAt ?? member.createdAt).getTime();
    if (!Number.isFinite(anchor)) return false;
    const idle = now.getTime() - anchor > ACCESS_REVIEW_IDLE_DAYS * DAY_MS;
    if (!idle) return false;

    if (member.accessReviewedAt == null) return true;
    const reviewed = new Date(member.accessReviewedAt).getTime();
    if (!Number.isFinite(reviewed)) return true;
    return (
        now.getTime() - reviewed > ACCESS_REVIEW_ATTESTATION_FRESH_DAYS * DAY_MS
    );
}
