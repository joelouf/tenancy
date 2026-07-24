/**
 * The Mongoose enforcement adapter: TypeScript Declarations.
 *
 * @module adapters/mongoose
 * @version 1.0.1
 */
import type { PipelineStage, Schema } from 'mongoose';

export interface TenantFieldsOptions {
    /** The registered model name the `workspaceId` ref points at (e.g. "Workspace"). */
    workspaceRef: string;
    /**
     * The registered model name the `entityId` ref points at (e.g. "Entity"). Required when
     * `entityOwned` is declared.
     */
    entityRef?: string;
    /**
     * Declares the model entity-owned: adds a nullable entityId path, its compound index, and
     * attaches the ownership record the scope plugin reads. Consumers should reconcile these
     * declarations against their `entityOwnedCollections` configuration with the tenant-models
     * guard.
     */
    entityOwned?: boolean;
    /**
     * Entity-owned models where a null entityId is a real state (a workspace-level document
     * visible to every member) rather than a pre-sweep gap. Narrowed contexts may write null
     * entityIds only on schemas that declare it.
     */
    workspaceLevelNulls?: boolean;
}

/**
 * The declared ownership record, attached to the schema object under
 * `Symbol.for('@joelouf/tenancy/ownership')`. Schema-attached rather than registry-held so a
 * split module copy cannot make the reader disagree with the writer.
 */
export interface EntityOwnership {
    readonly workspaceLevelNulls: boolean;
}

export declare function tenantFieldsPlugin(
    schema: Schema,
    options: TenantFieldsOptions
): void;

export declare function workspaceScopePlugin(schema: Schema): void;

/** Stages allowed inside a `$lookup` sub-pipeline ($out/$merge are not). */
export type LookupSubStage = Exclude<
    PipelineStage,
    PipelineStage.Merge | PipelineStage.Out
>;

export interface ScopedLookupOptions {
    from: string;
    as: string;
    localField?: string;
    foreignField?: string;
    let?: Record<string, unknown>;
    /** Sub-pipeline stages AFTER the mandatory workspace `$match`. */
    pipeline?: LookupSubStage[];
}

export type ScopedLookupStage = PipelineStage.Lookup;

export declare function scopedLookup(
    options: ScopedLookupOptions
): ScopedLookupStage;
