import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    parseScopeSelection,
    scopeSelectionToParam,
    canonicalScopeSelection
} from '../grammar/index.js';

test('parses "all" and round-trips it', () => {
    const parsed = parseScopeSelection('all');
    assert.deepEqual(parsed, { kind: 'all' });
    assert.equal(scopeSelectionToParam({ kind: 'all' }), 'all');
});

test('parses each kind:id form and round-trips it byte-identically', () => {
    const id = '0123456789abcdef01234567';
    for (const kind of /** @type {const} */ (['group', 'property', 'entity'])) {
        const raw = `${kind}:${id}`;
        const parsed = parseScopeSelection(raw);
        assert.deepEqual(parsed, { kind, id });
        assert.equal(
            scopeSelectionToParam(/** @type {NonNullable<typeof parsed>} */ (parsed)),
            raw
        );
    }
});

test('rejects malformed selections rather than guessing', () => {
    assert.equal(parseScopeSelection(null), null);
    assert.equal(parseScopeSelection(undefined), null);
    assert.equal(parseScopeSelection(''), null);
    assert.equal(parseScopeSelection('everything'), null);
    assert.equal(parseScopeSelection('group'), null);
    assert.equal(parseScopeSelection('group:'), null);
    assert.equal(parseScopeSelection('group:nothex'), null);
    assert.equal(parseScopeSelection('group:0123456789abcdef0123456'), null);
    assert.equal(
        parseScopeSelection('company:0123456789abcdef01234567'),
        null
    );
});

test('canonicalScopeSelection lowercases ids and leaves "all" untouched', () => {
    const upper = parseScopeSelection('entity:0123456789ABCDEF01234567');
    assert.notEqual(upper, null);
    assert.deepEqual(
        canonicalScopeSelection(/** @type {NonNullable<typeof upper>} */ (upper)),
        { kind: 'entity', id: '0123456789abcdef01234567' }
    );
    assert.deepEqual(canonicalScopeSelection({ kind: 'all' }), {
        kind: 'all'
    });
});

test('the grammar module graph is builtin-free and core-free (client-bundle safety)', async () => {
    // Mechanism: a static walk of import/export specifiers from grammar/index.js. The grammar
    // subpath must never pull node: builtins (a "use client" bundle cannot carry
    // node:async_hooks) nor any core module — this scan pins the whole transitive graph, not
    // just the entry file.
    const importRe =
        /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {string[]} */
    const queue = [
        fileURLToPath(new URL('../grammar/index.js', import.meta.url))
    ];
    while (queue.length > 0) {
        const file = /** @type {string} */ (queue.pop());
        if (visited.has(file)) continue;
        visited.add(file);
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(importRe)) {
            const specifier = match[1] ?? match[2];
            assert.ok(
                specifier.startsWith('./') || specifier.startsWith('../'),
                `grammar module graph must stay dependency-free, found "${specifier}" in ${file}`
            );
            assert.ok(
                !specifier.includes('/core/'),
                `grammar must not import core modules, found "${specifier}" in ${file}`
            );
            queue.push(fileURLToPath(new URL(specifier, `file://${file}`)));
        }
    }
    assert.ok(visited.size >= 1);
});
