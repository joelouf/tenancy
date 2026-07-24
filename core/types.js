/**
 * Shared structural types for the tenancy engine: the id shape, the logger port, and the
 * configuration record. JSDoc type definitions only, no runtime code; the core never depends on a
 * concrete driver id class, so any object with the ObjectId surface (Mongoose/BSON ObjectIds
 * included) satisfies these shapes structurally.
 *
 * @module core/types
 */

/**
 * @typedef {object} ObjectIdLike
 * @property {() => string} toHexString
 * @property {() => string} toString
 * @property {(other: unknown) => boolean} equals
 */

/**
 * @typedef {'error' | 'warn' | 'info' | 'debug'} LogLevel
 */

/**
 * @typedef {object} LoggerPort
 * @property {(level: import('./types.js').LogLevel, message: string, fields?: Record<string, unknown>) => void} log
 */

/**
 * @typedef {object} TenancyConfiguration
 * @property {readonly string[]} [entityOwnedCollections]
 * @property {import('./types.js').LoggerPort | null} [logger]
 */

export {};
