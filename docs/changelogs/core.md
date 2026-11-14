# @strutvane/core

## 0.1.0-next.0

### Minor Changes

- First implementation of the Strutvane kernel (Phase 1):
  
  - Typed service container (transient, singleton and scoped lifetimes; circular-dependency detection; ordered disposal) and well-known tokens.
  - Providers and the application lifecycle (register → boot → shutdown in reverse order, bounded by a timeout).
  - Deep-frozen config with typed dotted paths, and env validation through any Standard Schema validator that lists every problem at once and never prints values.
  - Request context on `AsyncLocalStorage`; ordered, short-circuiting hooks with fail-closed and fail-soft handlers; a `DomainEvent` bus.
  - RFC-0003 errors: error classes, the error-code registry and `toProblem` (RFC 9457 with `issues` and `fieldErrors`); message catalogs with `{param}` and ICU plural formatting, the override chain, `Accept-Language` negotiation and a missing-key API.
  - RFC-0004 §2 default JSON-lines logger with redaction, context enrichment and a never-throw guarantee; a clock abstraction and monotonic UUIDv7 ids.
