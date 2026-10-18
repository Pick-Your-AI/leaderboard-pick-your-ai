# Local runtime implementation

This guide describes the local runtime implementation for the foundation work tracked by [LB-02.07](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/31), [LB-02.06](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/35), and [LB-02.05](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/34). Source code and scoped automated evidence are available; architecture acceptance, production readiness, source authorization and deployment still require their own delivery evidence.

## Toolchain and workspaces

The workspace targets Node.js 24 LTS and npm workspaces. Node 24 is the selected LTS line at this scaffold's creation; see the [Node.js release schedule](https://nodejs.org/en/about/previous-releases). Root workspaces explicitly include `packages/contracts`, `packages/github`, `packages/metrics`, `packages/ingestion` and `apps/*`. The root lockfile covers all packages, including ingestion, and root build/typecheck/tests validate ingestion before dependent applications. The focused ingestion workflow additionally runs PostgreSQL transaction/concurrency checks; its historical package lock remains available for isolated tooling.

Install dependencies with `npm ci`. Build and check all workspaces with `npm run build`, `npm run typecheck`, and `npm test`, in that order; tests load the built workspace outputs. Package imports should use declared package names; apps should not reach into another workspace's `src` by relative path. The contracts package is consumed as `@pick-your-ai/contracts`.

The current workspace inventory is:

| Location | Local implementation |
| --- | --- |
| `apps/web` | Public API UI, explicitly selected synthetic prototype, and protected account/admin UI |
| `apps/service` | Anonymous read API, public projection and revision notices |
| `apps/worker` | Bounded worker entry point requiring an explicitly supplied protected host module |
| `apps/pipeline` | Source-to-metric/publication integration and runtime adapters |
| `apps/controls` | Protected control routes, authorization boundaries and control storage |
| `packages/contracts` | Versioned leaderboard schemas and client types |
| `packages/github` | Source adapters and bounded pagination |
| `packages/metrics` | Metric definitions, counting and policy evaluation |
| `packages/ingestion` | Durable ingestion, replay and internal snapshot primitives |

The [architecture baseline](ARCHITECTURE.md) also records planned boundaries such as `packages/ui`, which is not a current workspace. A directory or passing test does not establish completion of the associated work package.

## Local startup

Copy `.env.example` to `.env` and start PostgreSQL with `docker compose up -d db`. Apply migrations with `npm run db:migrate`. In separate terminals run `npm run dev:service`, `npm run dev:web`, and `npm run dev:worker`. The service binds to `127.0.0.1:3001`, the web development server uses `127.0.0.1:5173`, and the worker requires an explicit protected host module before it can collect. See [the worker entrypoint](worker-entrypoint.md) for bounded invocation and shutdown behavior.

The browser defaults to the [public API UI](remote-ui.md), using `VITE_PUBLIC_API_BASE` or same-origin `/api/v1`. The development server proxies that default path to the local service. The [read API](read-api.md) returns unavailable data and health when no approved public snapshot source is supplied; merely starting the database and development servers does not publish rankings. Select `?ui=prototype` to view the explicitly fictional boards and evidence, or `?ui=api` to return to API mode. The browser remembers an explicit mode choice. API failures never switch to synthetic data.

The sample database credentials are for loopback development only. These local database commands reject non-local hosts and names that do not end in `_dev` or `_test`; they do not accept production connection strings.

## Synthetic fixture and migration workflow

Fixtures live under `tests/fixtures/` and are fictional, explicitly marked, cross-project samples. They contain no real people, emails, repositories, or contributor evidence. Importing them requires `ALLOW_SYNTHETIC_FIXTURES=1` and a loopback database whose name ends in `_dev` or `_test`:

```bash
ALLOW_SYNTHETIC_FIXTURES=1 npm run db:seed:synthetic
```

Migrations use paired `.up.sql` and `.down.sql` files. The runner stores checksums and refuses to silently accept edits to an applied migration. `npm run db:validate` applies migrations, rolls back the last one, then applies it again; run it only on a disposable local/test database with a name ending in `_dev` or `_test`. To manually roll back one migration, set `ALLOW_LOCAL_DB_ROLLBACK=1` before `npm run db:rollback`.

Synthetic rows are marked in the database. The fixture seeding command does not collect real source data and is not wired to the worker's source collection.

## CI boundary and open decisions

The scoped workflow runs without repository secrets. It checks workspace build/typechecking/tests, a fresh PostgreSQL migration cycle, and the repository's required planning validation and generated-document check. Fork pull requests receive no privileged credentials. Dependabot opens weekly review pull requests for npm workspaces and workflow actions. Branch protection and required-check selection, architecture acceptance, package ownership, independent accessibility acceptance, source permissions, deployment host, retention, and operations acceptance require their own decisions and evidence. Local implementation and automated browser checks do not satisfy those broader gates.

## Synthetic schema rollback recovery receipt

The isolated recovery CI also exercises the actual `infra/db/migrations` schema
and `tests/fixtures/synthetic-observations.json`: apply every forward migration,
seed the explicitly fictional projects/actors/observations, encrypt a PostgreSQL
dump, apply every rollback in reverse, verify that no application tables remain,
and restore into the emptied disposable database. It compares every seeded row,
clock, migration checksum, column, constraint and index against the pre-rollback
state. `infra/recovery/test/schema-rollback.test.mjs` is skipped without the
explicit dedicated test container; CI requires zero skipped recovery tests.
This validates local fixture-schema rollback compatibility, not production
recovery objectives, external data completeness or release acceptance.
