import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {
    SUPPRESSION_MARKER,
    isExcludedPath,
    isSuppressed,
    scanLines,
    createWorkspaceScopeCheck,
    modelNameFromPath,
    entityOwnedListDriftProblems,
    scanPluginCoverage,
    createTenantModelsCheck
} from '../guards/index.js';

// ---------------------------------------------------------------------------------------------
// File exclusion.
// ---------------------------------------------------------------------------------------------

test('excludes the guard config script itself when its path is supplied', () => {
    assert.equal(
        isExcludedPath(
            'scripts/check-workspace-scope.ts',
            'scripts/check-workspace-scope.ts'
        ),
        true
    );
    assert.equal(isExcludedPath('scripts/check-workspace-scope.ts'), false);
});

test('excludes co-located test files and anything under a tests/ directory', () => {
    assert.equal(isExcludedPath('lib/tenant/scope.test.ts'), true);
    assert.equal(isExcludedPath('app/api/cron/route.test.ts'), true);
    assert.equal(isExcludedPath('tests/tenant/workspace-scope.test.ts'), true);
    assert.equal(isExcludedPath('tests/scripts/migration-safety.test.ts'), true);
});

test('does not exclude ordinary source files', () => {
    assert.equal(isExcludedPath('lib/tenant/scope.ts'), false);
    assert.equal(isExcludedPath('app/api/cron/expire-leases/route.ts'), false);
    assert.equal(isExcludedPath('scripts/migrate-tenancy-backfill.ts'), false);
});

// ---------------------------------------------------------------------------------------------
// The suppression grammar.
// ---------------------------------------------------------------------------------------------

test('flags an unmarked runAsSystem( call', () => {
    const lines = [
        'export function bypass() {',
        "    return runAsSystem('reason', fn);",
        '}'
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'runAsSystem');
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].suppressed, false);
});

test('suppresses a runAsSystem( call marked on the line above', () => {
    const lines = [
        'export function bypass() {',
        `    ${SUPPRESSION_MARKER} runAsSystem fixture`,
        "    return runAsSystem('reason', fn);",
        '}'
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].suppressed, true);
});

test('suppresses a runAsSystem( call marked with a trailing comment on the same line', () => {
    const lines = [
        `    return runAsSystem('reason', fn); ${SUPPRESSION_MARKER} runAsSystem fixture`
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].suppressed, true);
});

test('does not let a marker two lines above suppress a finding', () => {
    const lines = [
        `    ${SUPPRESSION_MARKER} runAsSystem fixture`,
        '    const noop = 1;',
        "    return runAsSystem('reason', fn);"
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].suppressed, false);
});

test('flags an unmarked raw $lookup pipeline stage', () => {
    const lines = ["const stage = { $lookup: { from: 'x' } };"];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'raw-$lookup');
    assert.equal(findings[0].suppressed, false);
});

test('suppresses a marked raw $lookup pipeline stage', () => {
    const lines = [
        `${SUPPRESSION_MARKER} raw-$lookup fixture`,
        "const stage = { $lookup: { from: 'x' } };"
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].suppressed, true);
});

test('does not flag $lookup mentioned in prose without a trailing colon', () => {
    const lines = ['/** Build a `$lookup` sub-pipeline manually. */'];
    assert.equal(scanLines('fixture.ts', lines).length, 0);
});

test('does not flag runAsSystem appearing in a generic-typed definition signature', () => {
    const lines = ['export function runAsSystem<T>('];
    assert.equal(scanLines('fixture.ts', lines).length, 0);
});

test('does not let a runAsSystem marker suppress an adjacent raw $lookup (kind-matched)', () => {
    const lines = [
        `    ${SUPPRESSION_MARKER} runAsSystem fixture`,
        "    const stage = { $lookup: { from: 'x' } };"
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'raw-$lookup');
    assert.equal(findings[0].suppressed, false);
});

test('does not treat a doc comment merely mentioning the marker as a suppressor', () => {
    const lines = [
        ` * Sanctioned sites carry a ${SUPPRESSION_MARKER} marker.`,
        "    return runAsSystem('reason', fn);"
    ];
    const findings = scanLines('fixture.ts', lines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].suppressed, false);
});

test('isSuppressed requires a kind-matched marker', () => {
    const lines = [`${SUPPRESSION_MARKER} runAsSystem fixture`, 'code'];
    assert.equal(isSuppressed(lines, 2, 'runAsSystem'), true);
    assert.equal(isSuppressed(lines, 2, 'raw-$lookup'), false);
});

test('flags unscoped $graphLookup and $unionWith stages (same leak semantics, no runtime backstop)', () => {
    assert.equal(
        scanLines('fixture.ts', ["  { $graphLookup: { from: 'x' } }"]).length,
        1
    );
    assert.equal(
        scanLines('fixture.ts', ["  { $unionWith: { coll: 'x' } }"]).length,
        1
    );
});

// ---------------------------------------------------------------------------------------------
// The workspace-scope check core over fixture sources.
// ---------------------------------------------------------------------------------------------

/** @param {Record<string, string>} sources */
const fixtureIo = (sources) => ({
    /** @param {string} file */
    readFile: async (file) => {
        const source = sources[file];
        if (source === undefined) throw new Error(`no fixture: ${file}`);
        return source;
    },
    listFiles: async () => Object.keys(sources)
});

test('the scope check scans, suppresses, excludes tests, and reports advice naming the sanctioned join', async () => {
    const io = fixtureIo({
        'lib/a.ts': [
            "const stage = { $lookup: { from: 'x' } };",
            `${SUPPRESSION_MARKER} runAsSystem sanctioned cron`,
            "runAsSystem('cron', fn);"
        ].join('\n'),
        'lib/b.ts': "export const fine = 'nothing to see';",
        'tests/c.test.ts': "runAsSystem('fixture', fn);",
        'scripts/my-guard.ts': 'const RAW = /$lookup:/;'
    });
    const check = createWorkspaceScopeCheck({
        globs: ['lib/**/*.ts'],
        sanctionedJoinName: 'scopedLookup',
        guardScriptPath: 'scripts/my-guard.ts',
        ...io
    });
    const result = await check();
    assert.equal(result.filesScanned, 2);
    assert.equal(result.findings.length, 2);
    assert.equal(result.unsuppressed.length, 1);
    assert.equal(result.unsuppressed[0].kind, 'raw-$lookup');
    assert.equal(result.suppressedCount, 1);
    assert.match(result.advice, /scopedLookup\(\)/);
});

test('a clean tree reports zero findings', async () => {
    const check = createWorkspaceScopeCheck({
        globs: ['lib/**/*.ts'],
        sanctionedJoinName: 'scopedLookup',
        ...fixtureIo({ 'lib/clean.ts': 'export const a = 1;' })
    });
    const result = await check();
    assert.equal(result.findings.length, 0);
    assert.equal(result.unsuppressed.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The tenant-models check core over fixture sources.
// ---------------------------------------------------------------------------------------------

const PLUGIN_SPECIFIERS = {
    tenantFields: {
        module: '@/lib/db/tenantFields.plugin',
        exportName: 'tenantFieldsPlugin'
    },
    workspaceScope: {
        module: '@/lib/db/workspaceScope.plugin',
        exportName: 'workspaceScopePlugin'
    }
};

/**
 * @param {string} name
 * @param {{ tenantFields?: boolean, workspaceScope?: boolean, entityOwned?: boolean,
 *     localImposter?: boolean }} [shape]
 */
const modelSource = (name, shape = {}) => {
    const lines = [];
    if (shape.tenantFields !== false && !shape.localImposter) {
        lines.push(
            'import { tenantFieldsPlugin } from "@/lib/db/tenantFields.plugin";'
        );
    }
    if (shape.workspaceScope !== false) {
        lines.push(
            'import { workspaceScopePlugin } from "@/lib/db/workspaceScope.plugin";'
        );
    }
    lines.push('import { Schema, model } from "mongoose";');
    lines.push('const schema = new Schema({ name: String });');
    if (shape.localImposter) {
        lines.push('function tenantFieldsPlugin(schema: unknown): void {}');
    }
    if (shape.tenantFields !== false || shape.localImposter) {
        lines.push(
            shape.entityOwned
                ? 'schema.plugin(tenantFieldsPlugin, { entityOwned: true });'
                : 'schema.plugin(tenantFieldsPlugin);'
        );
    }
    if (shape.workspaceScope !== false) {
        lines.push('schema.plugin(workspaceScopePlugin);');
    }
    lines.push(`export default model("${name}", schema);`);
    return lines.join('\n');
};

test('scanPluginCoverage matches by import source, not identifier text; a local imposter does not count', () => {
    const covered = ts.createSourceFile(
        'lib/models/Contact.ts',
        modelSource('Contact'),
        ts.ScriptTarget.Latest,
        true
    );
    assert.deepEqual(scanPluginCoverage(ts, covered, PLUGIN_SPECIFIERS), {
        tenantFields: true,
        workspaceScope: true,
        entityOwned: false
    });

    const imposter = ts.createSourceFile(
        'lib/models/Rogue.ts',
        modelSource('Rogue', { localImposter: true }),
        ts.ScriptTarget.Latest,
        true
    );
    const coverage = scanPluginCoverage(ts, imposter, PLUGIN_SPECIFIERS);
    assert.equal(coverage.tenantFields, false);
    assert.equal(coverage.workspaceScope, true);
});

test('scanPluginCoverage sees entityOwned: true on the tenantFieldsPlugin call', () => {
    const sourceFile = ts.createSourceFile(
        'lib/models/Property.ts',
        modelSource('Property', { entityOwned: true }),
        ts.ScriptTarget.Latest,
        true
    );
    assert.equal(
        scanPluginCoverage(ts, sourceFile, PLUGIN_SPECIFIERS).entityOwned,
        true
    );
});

test('modelNameFromPath strips the directory and the .ts/.tsx extension', () => {
    assert.equal(modelNameFromPath('lib/models/Property.ts'), 'Property');
    assert.equal(modelNameFromPath('lib/models/Widget.tsx'), 'Widget');
    assert.equal(modelNameFromPath('Loose.ts'), 'Loose');
});

test('entityOwnedListDriftProblems catches both drift directions and passes when aligned', () => {
    assert.deepEqual(
        entityOwnedListDriftProblems(
            { Property: 'properties' },
            ['properties']
        ),
        []
    );
    const missingFromList = entityOwnedListDriftProblems(
        { Property: 'properties', Lease: 'leases' },
        ['properties']
    );
    assert.equal(missingFromList.length, 1);
    assert.match(missingFromList[0], /"leases".*missing from entityOwnedCollections/s);

    const orphanCollection = entityOwnedListDriftProblems(
        { Property: 'properties' },
        ['properties', 'files']
    );
    assert.equal(orphanCollection.length, 1);
    assert.match(orphanCollection[0], /"files".*no entity-owned model/s);
});

test('the tenant-models check enforces coverage, exemptions, and entity-ownership in both directions', async () => {
    const sources = {
        'lib/models/index.ts': 'export {};',
        'lib/models/Contact.ts': modelSource('Contact'),
        'lib/models/Property.ts': modelSource('Property', {
            entityOwned: true
        }),
        'lib/models/Sneaky.ts': modelSource('Sneaky', { entityOwned: true }),
        'lib/models/Bare.ts': modelSource('Bare', {
            tenantFields: false,
            workspaceScope: false
        }),
        'lib/models/Workspace.ts': 'export const controlPlane = true;'
    };
    const check = createTenantModelsCheck({
        ts,
        pluginSpecifiers: PLUGIN_SPECIFIERS,
        controlPlane: ['Workspace'],
        scheduledDebt: [],
        entityOwned: { Property: 'properties' },
        entityOwnedCollections: ['properties'],
        readFile: async (file) => sources[/** @type {keyof typeof sources} */ (file)],
        listFiles: async () => Object.keys(sources)
    });
    const result = await check();
    assert.deepEqual(result.driftProblems, []);
    assert.equal(result.totalCount, 5, 'index is filtered out');
    assert.equal(result.exemptCount, 1);
    assert.equal(result.coveredCount, 2);
    assert.equal(result.violations.length, 2);
    const byModel = new Map(result.violations.map((v) => [v.modelName, v]));
    assert.match(
        byModel.get('Sneaky')?.problems.join('; ') ?? '',
        /declares entityOwned: true but is not in the entityOwned map/
    );
    assert.deepEqual(byModel.get('Bare')?.problems, [
        'missing tenantFieldsPlugin',
        'missing workspaceScopePlugin'
    ]);
    assert.equal(result.ok, false);
});

test('a missing entityOwned declaration on a mapped model is a violation', async () => {
    const sources = {
        'lib/models/Property.ts': modelSource('Property')
    };
    const check = createTenantModelsCheck({
        ts,
        pluginSpecifiers: PLUGIN_SPECIFIERS,
        controlPlane: [],
        scheduledDebt: [],
        entityOwned: { Property: 'properties' },
        entityOwnedCollections: ['properties'],
        readFile: async () => sources['lib/models/Property.ts'],
        listFiles: async () => Object.keys(sources)
    });
    const result = await check();
    assert.equal(result.violations.length, 1);
    assert.match(
        result.violations[0].problems.join('; '),
        /missing entityOwned: true/
    );
});

test('drift problems surface in the result even when every model is covered', async () => {
    const check = createTenantModelsCheck({
        ts,
        pluginSpecifiers: PLUGIN_SPECIFIERS,
        controlPlane: [],
        scheduledDebt: [],
        entityOwned: { Property: 'properties' },
        entityOwnedCollections: [],
        readFile: async () => modelSource('Property', { entityOwned: true }),
        listFiles: async () => ['lib/models/Property.ts']
    });
    const result = await check();
    assert.equal(result.driftProblems.length, 1);
    assert.equal(result.ok, false);
});
