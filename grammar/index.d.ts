/**
 * The scope-selection grammar — TypeScript Declarations.
 *
 * @module grammar
 * @version 1.0.0
 */

export type ScopeSelectionKind = 'group' | 'property' | 'entity';

export type ScopeSelection =
    | { kind: 'all' }
    | { kind: ScopeSelectionKind; id: string };

export interface ScopeOptionGroup {
    id: string;
    name: string;
}

export interface ScopeOptionProperty {
    id: string;
    label: string;
}

export interface ScopeOptionEntity {
    id: string;
    name: string;
}

export interface ScopeOptions {
    entities: ScopeOptionEntity[];
    groups: ScopeOptionGroup[];
    properties: ScopeOptionProperty[];
}

export declare function parseScopeSelection(
    raw: string | null | undefined
): ScopeSelection | null;

export declare function scopeSelectionToParam(selection: ScopeSelection): string;

export declare function canonicalScopeSelection(
    selection: ScopeSelection
): ScopeSelection;
