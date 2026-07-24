/**
 * The guard cores — the two static checkers that keep a consumer honest, dependency-injected so
 * the package stays free of file-system and compiler dependencies.
 *
 * 1. The workspace-scope check flags the two highest-signal cross-workspace leak risks in a
 *    source tree: raw `$lookup` / `$graphLookup` / `$unionWith` stage keys (a `$lookup`
 *    sub-pipeline does NOT inherit the parent `$match`, so an unscoped join leaks across
 *    workspaces — joins must go through the sanctioned builder), and every ambient-bypass call
 *    site. Sanctioned sites carry an inline suppression marker on the finding's own line or the
 *    line directly above; there is no whole-file allow-list, so allow-listing one sanctioned
 *    line never blinds the guard to a new violation elsewhere in that file.
 *
 * 2. The tenant-models check AST-verifies (via an injected TypeScript compiler API) that every
 *    model file applies BOTH plugins by import-source-resolved binding — a same-named local
 *    function does not count — and that entity ownership is declared consistently in both
 *    directions, including drift between the entity-owned model map and the configured
 *    collection list.
 *
 * File I/O (listing and reading) and the `typescript` module itself are caller-supplied ports:
 * the package has no runtime dependency on either. The `ts` parameter is a TYPE-LEVEL dependency
 * only (`typeof import('typescript')` in the declarations).
 *
 * @module guards
 */

/** The inline suppression marker. Same-kind, same-line-or-line-above; nothing broader. */
export const SUPPRESSION_MARKER = '// scope-guard-allow:';

const RAW_LOOKUP_RE = /\$(lookup|graphLookup|unionWith)['"]?\s*:/;
const RUN_AS_SYSTEM_RE = /\brunAsSystem\s*\(/;

/**
 * True when a scanned file path must never be scanned for findings: the guard config script
 * itself (its detection logic and docs contain the literal strings it looks for) and test files
 * (which legitimately exercise the bypass in fixtures/teardowns).
 *
 * @param {string} file
 * @param {string | null} [guardScriptPath]
 * @returns {boolean}
 */
export function isExcludedPath(file, guardScriptPath = null) {
    if (guardScriptPath !== null && file === guardScriptPath) return true;
    if (file.includes('.test.')) return true;
    if (file.split('/').includes('tests')) return true;
    return false;
}

/**
 * @param {string[]} lines
 * @param {number} lineNo
 * @param {import('./index.js').FindingKind} kind
 * @returns {boolean}
 */
function hasMarker(lines, lineNo, kind) {
    if (lineNo < 1 || lineNo > lines.length) return false;
    const text = lines[lineNo - 1];
    return text.includes(SUPPRESSION_MARKER) && text.includes(kind);
}

/**
 * A finding on `line` (1-indexed) is suppressed by a marker on its own line or the line above —
 * but only when that marker names the same `kind`, so a bypass marker can never silence an
 * adjacent `$lookup` (and a doc comment merely mentioning the marker string suppresses nothing).
 *
 * @param {string[]} lines
 * @param {number} line
 * @param {import('./index.js').FindingKind} kind
 * @returns {boolean}
 */
export function isSuppressed(lines, line, kind) {
    return hasMarker(lines, line, kind) || hasMarker(lines, line - 1, kind);
}

/**
 * Scan already-split source lines of `file` for raw-$lookup / runAsSystem findings.
 *
 * @param {string} file
 * @param {string[]} lines
 * @returns {import('./index.js').Finding[]}
 */
export function scanLines(file, lines) {
    /** @type {import('./index.js').Finding[]} */
    const out = [];
    lines.forEach((text, i) => {
        const line = i + 1;
        if (RAW_LOOKUP_RE.test(text)) {
            out.push({
                file,
                line,
                kind: 'raw-$lookup',
                text: text.trim(),
                suppressed: isSuppressed(lines, line, 'raw-$lookup')
            });
        }
        if (RUN_AS_SYSTEM_RE.test(text)) {
            out.push({
                file,
                line,
                kind: 'runAsSystem',
                text: text.trim(),
                suppressed: isSuppressed(lines, line, 'runAsSystem')
            });
        }
    });
    return out;
}

/**
 * Build the workspace-scope check over injected file I/O. The returned function performs the
 * scan and reports; it never prints and never exits — advisory-vs-strict presentation is the
 * config script's concern.
 *
 * @param {import('./index.js').WorkspaceScopeCheckOptions} options
 * @returns {() => Promise<import('./index.js').WorkspaceScopeCheckResult>}
 */
export function createWorkspaceScopeCheck(options) {
    return async function runWorkspaceScopeCheck() {
        const listed = await options.listFiles(options.globs);
        const files = [...new Set(listed)];
        /** @type {import('./index.js').Finding[]} */
        const findings = [];
        let filesScanned = 0;
        for (const file of files) {
            if (isExcludedPath(file, options.guardScriptPath ?? null)) continue;
            filesScanned += 1;
            const source = await options.readFile(file);
            findings.push(...scanLines(file, source.split('\n')));
        }
        const unsuppressed = findings.filter((f) => !f.suppressed);
        return {
            findings,
            unsuppressed,
            suppressedCount: findings.length - unsuppressed.length,
            filesScanned,
            advice:
                `Build joins with ${options.sanctionedJoinName}() instead of raw $lookup stages; ` +
                `sanctioned sites carry "${SUPPRESSION_MARKER} <kind> <reason>" on the finding's line or the line above.`
        };
    };
}

/**
 * The model name a file path implies (basename minus the .ts/.tsx extension).
 *
 * @param {string} file
 * @returns {string}
 */
export function modelNameFromPath(file) {
    const base = file.split('/').pop() ?? file;
    return base.replace(/\.tsx?$/, '');
}

/**
 * Drift between the entity-owned model map (model name -> collection name) and the configured
 * entity-owned collection list. Entity ownership is declared in both places deliberately —
 * per-model flags for the plugins, one flat list for the join builder — and this check catches
 * the two lists disagreeing in either direction.
 *
 * @param {Readonly<Record<string, string>>} entityOwned
 * @param {readonly string[]} entityOwnedCollections
 * @returns {string[]}
 */
export function entityOwnedListDriftProblems(entityOwned, entityOwnedCollections) {
    /** @type {string[]} */
    const problems = [];
    const declaredCollections = new Set();
    for (const [modelName, collection] of Object.entries(entityOwned)) {
        if (!collection) {
            problems.push(
                `model "${modelName}" is in the entityOwned map but has no collection mapping — ` +
                    'add one so the configured collection list can be checked against it'
            );
            continue;
        }
        declaredCollections.add(collection);
        if (!entityOwnedCollections.includes(collection)) {
            problems.push(
                `model "${modelName}" (collection "${collection}") is entity-owned but the collection is ` +
                    'missing from entityOwnedCollections — joins against it would skip the entity pin; add it there'
            );
        }
    }
    for (const collection of entityOwnedCollections) {
        if (!declaredCollections.has(collection)) {
            problems.push(
                `collection "${collection}" is listed in entityOwnedCollections but no entity-owned model ` +
                    'declares it — remove it there or add the model to the entityOwned map'
            );
        }
    }
    return problems;
}

/**
 * Resolve every named import binding in a source file to its (module, exportName) origin, so
 * plugin application can be matched by import source rather than by identifier text.
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').SourceFile} sourceFile
 * @returns {Map<string, import('./index.js').PluginBindingSpecifier>}
 */
function resolveImportedBindings(ts, sourceFile) {
    /** @type {Map<string, import('./index.js').PluginBindingSpecifier>} */
    const bindings = new Map();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const moduleName = statement.moduleSpecifier.text;
        const namedBindings = statement.importClause?.namedBindings;
        if (namedBindings && ts.isNamedImports(namedBindings)) {
            for (const element of namedBindings.elements) {
                const exportName = (element.propertyName ?? element.name).text;
                bindings.set(element.name.text, {
                    module: moduleName,
                    exportName
                });
            }
        }
    }
    return bindings;
}

/**
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').Expression | undefined} argument
 * @returns {boolean}
 */
function declaresEntityOwned(ts, argument) {
    if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
    return argument.properties.some(
        (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'entityOwned' &&
            property.initializer.kind === ts.SyntaxKind.TrueKeyword
    );
}

/**
 * Whether a model source file applies both plugins (matched by import-source-resolved binding)
 * and whether its tenantFieldsPlugin call declares `entityOwned: true`.
 *
 * @param {typeof import('typescript')} ts
 * @param {import('typescript').SourceFile} sourceFile
 * @param {import('./index.js').PluginSpecifiers} pluginSpecifiers
 * @returns {import('./index.js').PluginCoverage}
 */
export function scanPluginCoverage(ts, sourceFile, pluginSpecifiers) {
    const bindings = resolveImportedBindings(ts, sourceFile);
    /** @type {import('./index.js').PluginCoverage} */
    const coverage = {
        tenantFields: false,
        workspaceScope: false,
        entityOwned: false
    };

    /**
     * @param {import('typescript').Identifier} identifier
     * @param {import('./index.js').PluginBindingSpecifier} target
     * @returns {boolean}
     */
    const matchesBinding = (identifier, target) => {
        const binding = bindings.get(identifier.text);
        return (
            binding != null &&
            binding.module === target.module &&
            binding.exportName === target.exportName
        );
    };

    /** @param {import('typescript').Node} node */
    const visit = (node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'plugin'
        ) {
            const arg0 = node.arguments[0];
            if (arg0 && ts.isIdentifier(arg0)) {
                if (matchesBinding(arg0, pluginSpecifiers.tenantFields)) {
                    coverage.tenantFields = true;
                    if (declaresEntityOwned(ts, node.arguments[1])) {
                        coverage.entityOwned = true;
                    }
                }
                if (matchesBinding(arg0, pluginSpecifiers.workspaceScope)) {
                    coverage.workspaceScope = true;
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return coverage;
}

/**
 * Build the tenant-models check over an injected TypeScript compiler API and file I/O. The
 * returned function performs the drift check and the per-model coverage scan and reports; it
 * never prints and never exits.
 *
 * @param {import('./index.js').TenantModelsCheckOptions} options
 * @returns {() => Promise<import('./index.js').TenantModelsCheckResult>}
 */
export function createTenantModelsCheck(options) {
    return async function runTenantModelsCheck() {
        const driftProblems = entityOwnedListDriftProblems(
            options.entityOwned,
            options.entityOwnedCollections
        );
        const controlPlane = new Set(options.controlPlane);
        const scheduledDebt = new Set(options.scheduledDebt);
        const entityOwnedModels = new Set(Object.keys(options.entityOwned));

        const listed = await options.listFiles();
        const files = [...new Set(listed)]
            .filter((file) => modelNameFromPath(file) !== 'index')
            .sort();

        /** @type {import('./index.js').Violation[]} */
        const violations = [];
        let coveredCount = 0;
        let exemptCount = 0;

        for (const file of files) {
            const modelName = modelNameFromPath(file);
            if (controlPlane.has(modelName) || scheduledDebt.has(modelName)) {
                exemptCount += 1;
                continue;
            }

            const content = await options.readFile(file);
            const sourceFile = options.ts.createSourceFile(
                file,
                content,
                options.ts.ScriptTarget.Latest,
                true
            );
            const coverage = scanPluginCoverage(
                options.ts,
                sourceFile,
                options.pluginSpecifiers
            );
            /** @type {string[]} */
            const problems = [];
            if (!coverage.tenantFields) {
                problems.push('missing tenantFieldsPlugin');
            }
            if (!coverage.workspaceScope) {
                problems.push('missing workspaceScopePlugin');
            }
            if (entityOwnedModels.has(modelName) && !coverage.entityOwned) {
                problems.push(
                    'missing entityOwned: true on tenantFieldsPlugin (model is in the entityOwned map)'
                );
            }
            if (!entityOwnedModels.has(modelName) && coverage.entityOwned) {
                problems.push(
                    'declares entityOwned: true but is not in the entityOwned map — add it there deliberately or drop the flag'
                );
            }

            if (problems.length > 0) {
                violations.push({ file, modelName, problems });
            } else {
                coveredCount += 1;
            }
        }

        return {
            driftProblems,
            violations,
            coveredCount,
            exemptCount,
            totalCount: files.length,
            ok: driftProblems.length === 0 && violations.length === 0
        };
    };
}
