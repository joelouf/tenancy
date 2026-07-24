// The package eats its own guard: the workspace-scope check runs over the shipped source (core,
// grammar, adapters, guards, the root barrel — .js and .d.ts alike) and must report zero
// unsuppressed findings. The engine's own sanctioned sites (the scopedLookup definition, the
// runAsSystem definition, the error-message mention) carry the same inline markers any consumer
// site would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceScopeCheck } from '../guards/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function walk(directory) {
    const entries = await readdir(path.join(packageRoot, directory), {
        withFileTypes: true
    });
    /** @type {string[]} */
    const files = [];
    for (const entry of entries) {
        const relative = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await walk(relative)));
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
            files.push(relative);
        }
    }
    return files;
}

test('the workspace-scope guard reports zero unsuppressed findings over the shipped source', async () => {
    const check = createWorkspaceScopeCheck({
        globs: ['core/**/*', 'grammar/**/*', 'adapters/**/*', 'guards/**/*'],
        sanctionedJoinName: 'scopedLookup',
        guardScriptPath: 'guards/index.js',
        readFile: (file) => readFile(path.join(packageRoot, file), 'utf8'),
        listFiles: async () => [
            'index.js',
            'index.d.ts',
            ...(await walk('core')),
            ...(await walk('grammar')),
            ...(await walk('adapters')),
            ...(await walk('guards'))
        ]
    });
    const result = await check();
    assert.ok(result.filesScanned >= 20, `scanned ${result.filesScanned} files`);
    assert.deepEqual(
        result.unsuppressed.map((f) => `${f.file}:${f.line} ${f.kind}`),
        [],
        'every finding in the shipped source must carry a same-kind suppression marker'
    );
    assert.ok(
        result.suppressedCount >= 2,
        'the sanctioned definition sites are visible to the guard, not invisible to it'
    );
});
