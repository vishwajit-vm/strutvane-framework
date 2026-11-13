<div align="center">

# Strutvane Core

**The Strutvane kernel: application lifecycle, typed service container, service providers, validated config and env, request context, hooks, events, logging, errors and the plugin host.**

[![Status: 0.1.0-next](https://img.shields.io/badge/status-0.1.0--next-orange)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Status: `0.1.0-next.0`, implemented and tested, but not yet released to npm.** The API follows [RFC-0003](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0003-errors-and-messages.md) (errors and messages) and [RFC-0004 §2](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md) (default logger), and may still change before `0.1.0`. The version on npm today is only a name placeholder.

## What it is

Strutvane Core is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. You declare models as fields and types, and get migrations, a secured CRUD API, auth/RBAC/tenancy and a complete UI. Every line stays owned, overridable TypeScript.

Core is the small kernel every other package plugs into. It depends only on [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts): no database, HTTP engine, UI or logging library.

## What's inside

| Module | What you get |
|---|---|
| **Container** | `token<T>()`, `createContainer()`: transient, singleton and scoped lifetimes, request scopes, circular-dependency errors that show the full path, and disposal in reverse order. No decorators or reflection. |
| **Application** | `createApp()`, `defineProvider()`: register → boot → shutdown. Shutdown runs in reverse order, collects every failure and is bounded by a timeout, so one hanging provider can't block it. |
| **Config** | `defineConfig()`, `app.config('database.pool.max')`: deep-frozen config read by typed dotted paths. A wrong path fails to compile. |
| **Env** | `defineEnv(schema)`: validates `process.env` with any [Standard Schema](https://standardschema.dev) validator (Zod 4, Valibot, ArkType). Lists **every** problem in one message and never prints values. |
| **Request context** | `runWithContext()`, `currentContext()`: request id, trace id, actor, tenant and locale on `AsyncLocalStorage`. |
| **Hooks** | `createHooks()`: typed, ordered (`before`/`after`) and short-circuiting (`stop()`). Failures are fail-closed unless a handler opts into `failSoft`. |
| **Events** | `createEventBus()`: emits contract `DomainEvent`s with ids and timestamps. One failing listener never affects the others. |
| **Errors** | `ValidationError`, `NotFoundError`, `DomainError` and friends, the error-code registry, and `toProblem()`, which returns an RFC 9457 `Problem` with `issues` and `fieldErrors`. Unknown errors become a 500 with **no internal details**. |
| **Messages** | `createMessages()`: catalogs with `{param}` and ICU plural formatting, the override chain (field → resource → app → package → built-in), `Accept-Language` negotiation and a missing-key API for `sv lang:check`. |
| **Logger** | `createLogger()`: the zero-dependency fallback logger (`@strutvane/logs` replaces it by default). One JSON line per call, secrets redacted, context added automatically, and it never throws. |
| **Clock and ids** | `systemClock`, `createTestClock()`, `uuidv7()`: monotonic, time-ordered RFC 9562 UUIDv7 ids. |
| **Tokens** | `LoggerToken`, `ClockToken`, `IdGeneratorToken`, `MessagesToken`, `ErrorRegistryToken`, `EventBusToken`, `HooksToken`, `PermissionProviderToken`. |

## Quick start

```ts
import { z } from 'zod'
import { createApp, defineEnv, defineProvider, EventBusToken, LoggerToken, token } from '@strutvane/core'

interface Mailer {
  send(to: string, subject: string): Promise<void>
}
const MailerToken = token<Mailer>('mailer')

// Fails fast at startup and lists every missing or invalid key (never the values).
const env = defineEnv(z.object({ MAIL_FROM: z.email() }))

const mail = defineProvider({
  name: 'mail',
  register(app) {
    app.container.singleton(MailerToken, () => new SmtpMailer(env.MAIL_FROM))
  },
  boot(app) {
    app.make(EventBusToken).on('user.registered', async (event) => {
      const { email } = event.payload as { email: string }
      await app.make(MailerToken).send(email, 'Welcome!')
    })
  },
})

const app = createApp({ config: { app: { name: 'acme' } }, providers: [mail] })
await app.boot()
app.make(LoggerToken).info('Booted', { app: app.config('app.name') })

process.on('SIGTERM', () => void app.shutdown({ timeoutMs: 10_000 }))
```

The default services (logger, clock, ids, messages, error registry, event bus, hooks) are bound for you, and any provider can replace one. For example, `@strutvane/logs` rebinds `LoggerToken`.

A reusable package provider is typed `Provider<object>`: it works in any app, and `app.config()` returns `unknown` there, so validate what you read. An app's own provider can use `defineProvider<typeof config>()` to get fully typed config paths.

## Errors and messages

```ts
import { createMessages, defineMessages, DomainError, negotiateLocale, toProblem, ValidationError } from '@strutvane/core'

const messages = createMessages({
  app: [
    defineMessages('en', {
      'errors.INVOICE_ALREADY_PAID.title': 'Invoice already paid',
      'errors.INVOICE_ALREADY_PAID.detail': 'Invoice {number} was paid on {date}.',
    }),
    defineMessages('de', { 'validation.required': '{attribute} ist erforderlich.' }),
  ],
})
const locale = negotiateLocale(request.headers['accept-language'], messages.locales())

toProblem(new DomainError('INVOICE_ALREADY_PAID', { number: 'INV-7', date: '2026-11-01' }), { messages })
// { type: '…/invoice-already-paid', title: 'Invoice already paid', status: 422,
//   detail: 'Invoice INV-7 was paid on 2026-11-01.', code: 'INVOICE_ALREADY_PAID' }

toProblem(new ValidationError([{ path: ['dueDate'], code: 'required' }]), { messages, locale })
// { status: 422, code: 'VALIDATION_FAILED', issues: [...], fieldErrors: { dueDate: ['Due date ist erforderlich.'] } }
```

To translate field names, pass `labels` to `toProblem`, for example `{ dueDate: 'Fälligkeitsdatum' }`. Without labels, field names are humanized (`dueDate` → "Due date").

Plurals use ICU syntax: `'{count, plural, =0 {No files} one {# file} other {# files}}'`.

[`test/readme.test.ts`](test/readme.test.ts) runs both examples, so they always match the real API.

## Security notes

- **Errors never leak internals.** Anything that isn't a `StrutvaneError` becomes a generic 500. `toProblem` never throws: even with a broken catalog it returns a minimal problem.
- **Env errors never contain values**, only key names and validator messages.
- **The logger redacts** keys such as `password`, `token`, `secret`, `authorization`, `cookie` and `apiKey` at any depth. It escapes CR, LF and U+2028/2029, so one call is always one line (no log injection). A failing sink never crashes the app.
- **Parsers are bounded and fuzzed.** The message formatter (template length, nesting depth) and `Accept-Language` parsing (header length, entry count) are capped. Property tests (fast-check) check that the formatter never throws, whatever the input.
- **The container fails closed.** Scoped services can't be resolved from the root, singletons can't capture request-scoped services, and a service can't be rebound once it has been resolved.

## Installation (once released)

```bash
npm i @strutvane/core
```

## Development

```bash
corepack pnpm@12.18.0 install
corepack pnpm@12.18.0 run ci   # lint → typecheck → tests (incl. type tests) + coverage → build
```

| Script | What it does |
|---|---|
| `lint` / `format` | Biome check / auto-fix |
| `typecheck` | `tsc --noEmit` with the strictest settings |
| `test` / `test:coverage` | Vitest: runtime, property (fast-check) and type-level tests (`test/*.test-d.ts`). Coverage thresholds: 90/90/85/90. |
| `build` | tsdown → `dist/index.mjs` + `dist/index.d.mts` |

Until `@strutvane/contracts` is published, local development links it from `../contracts` through a temporary `overrides` entry in `pnpm-workspace.yaml`. That entry must not be committed (the CI `check-deps` guard rejects it).

Shared configs (`tsconfig.base.json`, `biome.base.json`, `vitest.shared.ts`, CI workflows) are synced from [strutvane-tooling](https://github.com/vishwajit-vm/strutvane-tooling). Don't edit them here.

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, errors, messages (this repo) |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [04-architecture.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/04-architecture.md); errors and messages: [RFC-0003](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0003-errors-and-messages.md); default logger: [RFC-0004](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0004-logs-package.md)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

Issues, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Public API changes need an RFC, tests, docs and a changeset.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
