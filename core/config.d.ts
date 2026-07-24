/**
 * The one-time tenancy configuration: TypeScript Declarations.
 *
 * @module core/config
 * @version 1.0.1
 */
import type { LoggerPort, TenancyConfiguration } from './types.js';

export declare function configureTenancy(
    configuration: TenancyConfiguration
): void;

export declare function configuredEntityOwnedCollections():
    | readonly string[]
    | null;

export declare function configuredLogger(): LoggerPort | null;
