# Security Policy

## Supported Versions

The latest published `1.x` release receives security fixes.

| Version | Supported |
|---|---|
| 1.x | yes |
| < 1.0 | no |

## Reporting a Vulnerability

Please report security issues privately, not through public issues or pull requests.

Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**), or email the maintainer. Include a description, affected version, and a minimal reproduction.

You can expect an acknowledgement within a few days. Once a fix is available, a patched release is published and the reporter is credited unless they prefer otherwise.

## Scope

`@joelouf/tenancy` is a tenant-isolation ENFORCEMENT ENGINE. Its core is zero-dependency decision logic and context machinery: it opens no network connections, reads no credentials, and never executes input as code. The Mongoose adapter subpath registers schema middleware on the host's schemas; it still opens no connection of its own — connection management, models, authentication, authorization vocabulary, and error transport all belong to the consuming application and are outside this package.

The relevant security surface is therefore the correctness of the enforcement decisions: that a missing context fails closed rather than widening a query; that cross-workspace reads, writes, inserts, and every re-home shape (including pipeline updates and operator payloads) are refused; that a narrowed membership cannot read or write outside its entity grants, and that a caller-crafted filter cannot un-pin it (the where-merge composition); that the sanctioned join builder refuses to run unconfigured; that the system bypass always emits its provenance line; that the resolver's refusals are enumeration-resistant; and that same-realm module duplication cannot split the shared context, configuration, or obligations state into a fail-open. A report demonstrating that any of these can be bypassed with plain probe schemas and an in-memory directory is in scope.

Known, documented non-goals: `Model.bulkWrite`, `estimatedDocumentCount`, and native `.collection.*` access bypass Mongoose query middleware by construction (mitigate with DB-level `$jsonSchema` validators); a vm or cross-realm split does not share the `Symbol.for` stashes; and the guard cores are lint-time aids, not runtime barriers.
