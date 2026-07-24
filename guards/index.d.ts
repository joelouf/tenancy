/**
 * The guard cores: TypeScript Declarations.
 *
 * The `ts` option is typed `typeof import('typescript')`: a TYPE-LEVEL dependency only. The
 * package never imports typescript at runtime and never installs it for consumers; the config
 * script that wires this check supplies its own compiler module.
 *
 * @module guards
 * @version 1.0.0
 */

export declare const SUPPRESSION_MARKER: '// scope-guard-allow:';

export type FindingKind = 'raw-$lookup' | 'runAsSystem';

export interface Finding {
    file: string;
    line: number;
    kind: FindingKind;
    text: string;
    suppressed: boolean;
}

export declare function isExcludedPath(
    file: string,
    guardScriptPath?: string | null
): boolean;

export declare function isSuppressed(
    lines: string[],
    line: number,
    kind: FindingKind
): boolean;

export declare function scanLines(file: string, lines: string[]): Finding[];

export interface WorkspaceScopeCheckOptions {
    /** The glob patterns handed to `listFiles`; the check itself does no globbing. */
    readonly globs: readonly string[];
    /** The sanctioned join builder's name, used in the returned advice line. */
    readonly sanctionedJoinName: string;
    /** The config script's own path, excluded from scanning (it quotes the patterns it hunts). */
    readonly guardScriptPath?: string | null;
    readonly readFile: (file: string) => Promise<string>;
    readonly listFiles: (globs: readonly string[]) => Promise<string[]>;
}

export interface WorkspaceScopeCheckResult {
    readonly findings: Finding[];
    readonly unsuppressed: Finding[];
    readonly suppressedCount: number;
    readonly filesScanned: number;
    readonly advice: string;
}

export declare function createWorkspaceScopeCheck(
    options: WorkspaceScopeCheckOptions
): () => Promise<WorkspaceScopeCheckResult>;

export declare function modelNameFromPath(file: string): string;

export declare function entityOwnedListDriftProblems(
    entityOwned: Readonly<Record<string, string>>,
    entityOwnedCollections: readonly string[]
): string[];

export interface PluginBindingSpecifier {
    readonly module: string;
    readonly exportName: string;
}

export interface PluginSpecifiers {
    readonly tenantFields: PluginBindingSpecifier;
    readonly workspaceScope: PluginBindingSpecifier;
}

export interface PluginCoverage {
    tenantFields: boolean;
    workspaceScope: boolean;
    entityOwned: boolean;
}

export interface Violation {
    file: string;
    modelName: string;
    problems: string[];
}

export declare function scanPluginCoverage(
    ts: typeof import('typescript'),
    sourceFile: import('typescript').SourceFile,
    pluginSpecifiers: PluginSpecifiers
): PluginCoverage;

export interface TenantModelsCheckOptions {
    /** The TypeScript compiler API module, supplied by the caller. */
    readonly ts: typeof import('typescript');
    readonly pluginSpecifiers: PluginSpecifiers;
    /** Model names exempt because they ARE the control plane (workspace/membership/user...). */
    readonly controlPlane: Iterable<string>;
    /** Model names exempt as recorded, scheduled debt. */
    readonly scheduledDebt: Iterable<string>;
    /** Entity-owned model names mapped to their collection names. */
    readonly entityOwned: Readonly<Record<string, string>>;
    /** The flat collection list the join builder is configured with. */
    readonly entityOwnedCollections: readonly string[];
    readonly readFile: (file: string) => Promise<string>;
    /** Returns the model files to scan; the check filters out `index` and sorts. */
    readonly listFiles: () => Promise<string[]>;
}

export interface TenantModelsCheckResult {
    readonly driftProblems: string[];
    readonly violations: Violation[];
    readonly coveredCount: number;
    readonly exemptCount: number;
    readonly totalCount: number;
    readonly ok: boolean;
}

export declare function createTenantModelsCheck(
    options: TenantModelsCheckOptions
): () => Promise<TenantModelsCheckResult>;
