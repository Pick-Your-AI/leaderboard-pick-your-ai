# Runtime foundation candidate

This branch adds a local, reviewable scaffold for the runtime work tracked by [LB-02.07](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/31), [LB-02.06](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/35), and [LB-02.05](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/issues/34). It does not represent architecture approval, production readiness, source authorization, or a deployed service.

## Toolchain and workspaces

The workspace targets Node.js 24 LTS and npm workspaces. Node 24 is the selected LTS line at this scaffold's creation; see the [Node.js release schedule](https://nodejs.org/en/about/previous-releases). Root workspaces include `packages/*` and `apps/*`, allowing contracts and GitHub source helpers to remain separate from the web, service, and worker applications.

Install dependencies with `npm ci`. Build and check all workspaces with `npm run build`, `npm run typecheck`, and `npm test`, in that order; tests load the built workspace outputs. Package imports should use declared package names; apps should not reach into another workspace's `src` by relative path. The contracts package is consumed as `@pick-your-ai/contracts`.

## Local startup

Copy `.env.example` to `.env` and start PostgreSQL with `docker compose up -d db`. Apply migrations with `npm run db:migrate`. In separate terminals run `npm run dev:service`, `npm run dev:web`, and `npm run dev:worker`. The service binds to `127.0.0.1:3001`, the web development server uses `127.0.0.1:5173`, and the worker currently reports that source collection is not configured. The web page labels itself as a scaffold and does not show rankings.

The sample database credentials are for loopback development only. Database commands reject non-local hosts and names that do not end in `_dev` or `_test`. No production connection string is supported by this scaffold.

## Synthetic fixture and migration workflow

Fixtures live under `tests/fixtures/` and are fictional, explicitly marked, cross-project samples. They contain no real people, emails, repositories, or contributor evidence. Importing them requires `ALLOW_SYNTHETIC_FIXTURES=1` and a loopback database whose name ends in `_dev` or `_test`:

```bash
$env:ALLOW_SYNTHETIC_FIXTURES = "1"
npm run db:seed:synthetic
```

Migrations use paired `.up.sql` and `.down.sql` files. The runner stores checksums and refuses to silently accept edits to an applied migration. `npm run db:validate` applies migrations, rolls back the last one, then applies it again; run it only on a disposable local/test database with a name ending in `_dev` or `_test`. To manually roll back one migration, set `ALLOW_LOCAL_DB_ROLLBACK=1` before `npm run db:rollback`.

Synthetic rows are marked in the database. No production importer exists here, and the sample fixture path is not wired to source collection.

## CI boundary and open decisions

The scoped workflow runs without repository secrets. It checks workspace build/typechecking/tests, a fresh PostgreSQL migration cycle, and the repository's required planning validation and generated-document check. Fork pull requests receive no privileged credentials. Dependabot opens weekly review pull requests for npm workspaces and workflow actions. Branch protection and required-check selection, architecture acceptance, package ownership, accessibility review, source permissions, deployment host, retention, and operations acceptance remain outside this local scaffold and need their own decisions and evidence.
