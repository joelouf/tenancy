/**
 * Invitation token custody.
 *
 * The raw token exists exactly once: in the delivered message body. The database stores only its
 * SHA-256 digest, so a database, backup, or log dump never yields a live credential — which is
 * what makes an email-verification bypass sound ("the token reached the mailbox, so the mailbox
 * is controlled"). Resending rotates the token rather than re-sending a stored one.
 *
 * The digest is deterministic and unsalted on purpose: the preimage is 256 bits of CSPRNG
 * output, so lookup is a single indexed equality (no per-row scan, and no attacker-controlled
 * string comparison to time). Any future short-code variant would need a different design.
 *
 * @module core/invitation-token
 */

import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;

/**
 * Mint a fresh invitation token: 256 bits of CSPRNG output, base64url-encoded.
 *
 * @returns {string}
 */
export function generateInvitationToken() {
    return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The storable digest of a token — the only form that ever touches persistence.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashInvitationToken(token) {
    return createHash('sha256').update(token).digest('hex');
}
