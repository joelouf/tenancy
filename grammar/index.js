/**
 * The scope-selection grammar: parsing and printing the `all` / `kind:id` scope parameter.
 *
 * This subpath is deliberately dependency-free AND context-free: it imports nothing (no core
 * modules, no node: builtins), so it is safe to bundle into client components; a client bundle
 * must never transitively pull node:async_hooks. A package test asserts this module graph stays
 * builtin-free; do not add imports here.
 *
 * @module grammar
 */

const SCOPE_OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * @param {string} value
 * @returns {value is import('./index.js').ScopeSelectionKind}
 */
function isScopeSelectionKind(value) {
    return value === 'group' || value === 'property' || value === 'entity';
}

/**
 * Parse a raw scope parameter. Returns null for anything malformed (an unknown kind, a
 * missing separator, or an id that is not 24 hex characters), so a caller can fall back to its
 * default scope rather than propagate garbage.
 *
 * @param {string | null | undefined} raw
 * @returns {import('./index.js').ScopeSelection | null}
 */
export function parseScopeSelection(raw) {
    if (raw == null) return null;
    if (raw === 'all') return { kind: 'all' };
    const separator = raw.indexOf(':');
    if (separator === -1) return null;
    const kind = raw.slice(0, separator);
    const id = raw.slice(separator + 1);
    if (!isScopeSelectionKind(kind)) return null;
    if (!SCOPE_OBJECT_ID.test(id)) return null;
    return { kind, id };
}

/**
 * Print a selection back to its parameter form, the inverse of `parseScopeSelection`.
 *
 * @param {import('./index.js').ScopeSelection} selection
 * @returns {string}
 */
export function scopeSelectionToParam(selection) {
    return selection.kind === 'all'
        ? 'all'
        : `${selection.kind}:${selection.id}`;
}

/**
 * The canonical form of a selection: ids lowercase, so hex-equal selections compare equal as
 * strings.
 *
 * @param {import('./index.js').ScopeSelection} selection
 * @returns {import('./index.js').ScopeSelection}
 */
export function canonicalScopeSelection(selection) {
    if (selection.kind === 'all') return selection;
    return { kind: selection.kind, id: selection.id.toLowerCase() };
}
