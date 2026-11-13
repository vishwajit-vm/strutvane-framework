<div align="center">

# Strutvane Framework

**The backend & database core of Strutvane: declare models as fields and types, get migrations, a secured CRUD API, OpenAPI docs, queues, cache and mail.**

[![Status: planning](https://img.shields.io/badge/status-planning-blueviolet)](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Part of Strutvane](https://img.shields.io/badge/ecosystem-Strutvane-1f3a5f)](https://github.com/vishwajit-vm/strutvane)

</div>

> [!NOTE]
> **Strutvane Framework is in the design phase.** The specification is written and implementation has not started. Nothing is published to npm yet, and the package name `@strutvane/framework` is reserved for this project. Follow [the roadmap](https://github.com/vishwajit-vm/strutvane/blob/main/docs/14-roadmap.md) for progress.

## What it is

Strutvane Framework is part of **[Strutvane](https://github.com/vishwajit-vm/strutvane)**, a TypeScript framework and package ecosystem for building enterprise B2B applications. You declare models as fields and types, and get migrations, a secured CRUD API, auth/RBAC/tenancy and a complete UI. Every line stays owned, overridable TypeScript.

## Planned capabilities

- **Model DSL**: `defineModel()` with typed `field.*` builders as the single source of truth
- **Migrations**: auto-diffed from models into reviewed SQL files, plus manual migrations, seeders and factories
- **Resource engine**: full CRUD with filtering, search, sorting, cursor pagination, includes, bulk actions, export, hooks and custom actions
- **HTTP**: Hono by default, with Express, Fastify and NestJS adapters, security headers, CORS, rate limiting and health endpoints
- **OpenAPI 3.1** with interactive docs at `/docs` and a typed client
- **Databases**: PostgreSQL (incl. Azure Flexible Server, passwordless), MySQL, SQLite/libSQL; MSSQL later
- **Platform**: queue and jobs, schedules, cache, mail, events/outbox, OpenTelemetry, API versioning, testing helpers

## A taste of the API (design preview)

```ts
import { defineModel, field } from '@strutvane/framework'

export default defineModel('Invoice', {
  number:   field.string().unique().searchable(),
  customer: field.belongsTo('Customer').filterable(),
  amount:   field.decimal(12, 2).min(0).sortable(),
  status:   field.enum(['draft', 'sent', 'paid']).default('draft').filterable(),
  dueDate:  field.date().sortable(),
}, { timestamps: true, softDeletes: true, tenant: true, audit: true })

// pnpm sv migrate  → SQL migration generated + applied
// pnpm dev         → GET/POST/PATCH/DELETE /api/v1/invoices, docs at /docs
```

## Installation (once released)

```bash
npm create strutvane@latest my-api -- --preset api
```

## Works alone, better together

| Package | Role |
|---------|------|
| [`@strutvane/framework`](https://github.com/vishwajit-vm/strutvane-framework) | Backend & database core |
| [`@strutvane/auth`](https://github.com/vishwajit-vm/strutvane-auth) | Authentication, authorization, tenancy, audit |
| [`@strutvane/ui`](https://github.com/vishwajit-vm/strutvane-ui) | Metadata-driven frontend |
| [`@strutvane/core`](https://github.com/vishwajit-vm/strutvane-core) | Kernel: container, providers, config, context |
| [`@strutvane/contracts`](https://github.com/vishwajit-vm/strutvane-contracts) | Shared types and wire protocols |
| [`strutvane` / `@strutvane/cli`](https://github.com/vishwajit-vm/strutvane-cli) | Unified CLI |
| [`@strutvane/devkit`](https://github.com/vishwajit-vm/strutvane-devkit) | SDK for installers, generators and plugins |
| [`@strutvane/logs`](https://github.com/vishwajit-vm/strutvane-logs) | Zero-config logging + built-in log viewer (default) |
| [`create-strutvane`](https://github.com/vishwajit-vm/create-strutvane) | Project starter |

## Documentation

- **Package specification:** [06-package-framework.md](https://github.com/vishwajit-vm/strutvane/blob/main/docs/06-package-framework.md)
- **Ecosystem blueprint:** [strutvane/docs](https://github.com/vishwajit-vm/strutvane/tree/main/docs), starting with the [executive summary](https://github.com/vishwajit-vm/strutvane/blob/main/docs/00-executive-summary.md) and the [developer experience](https://github.com/vishwajit-vm/strutvane/blob/main/docs/05-developer-experience.md)

## Contributing

Ideas and design feedback are welcome while the project is in the design phase. Open an issue or discussion, and see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 The Strutvane Authors
