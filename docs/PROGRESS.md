# Progress

What has been built, what was measured and what was put off, phase by phase.
The plan is in `PLAN.md`; the reasons behind choices are in `DECISIONS.md`.

## Phases

- [x] Phase 0: Project setup
- [ ] Phase 1: Data preparation (DuckDB)
- [ ] Phase 2: Ingestion into Postgres
- [ ] Phase 3: Baseline search without AI
- [ ] Phase 4: LLM provider and embeddings pipeline
- [ ] Phase 5: Semantic search
- [ ] Phase 6: Query understanding (parse)
- [ ] Phase 7: Pick, reasons and streaming
- [ ] Phase 8: Production concerns
- [ ] Phase 9: Evaluation
- [ ] Phase 10: LLM tag fallback (only if evaluation shows a need)
- [ ] Phase 11: Deploy V1

## Phase 0: Project setup

Status on 2026-10-10: done. The only thing not yet seen is the first GitHub
Actions run, which happens on the first push.

### Built

- Node 24 LTS (`.nvmrc`, `engines`), pnpm workspace with `apps/api`, `apps/web`
  and `packages/shared`. TypeScript strict, ESLint, Vitest.
- `apps/api/src/config/env.ts`: reads the root `.env`, validates it with Zod and
  lists every problem at once without printing any values.
- Migration runner (`pnpm db:migrate`) and `0001_enable_vector.sql` (D-028).
- `GET /api/health`: Postgres, pgvector version and Redis reported separately.
  200 when all are up, 503 otherwise. Each check has a timeout.
- Errors use the shape `{ error: { code, message } }`, including 404s.
- Web status page that calls `/api/health` through the Vite dev proxy.
- `packages/shared`: the Zod schema for the health response, used by both sides.
- ESLint rule that rejects a Gemini SDK import outside `apps/api/src/llm`.
- GitHub Actions workflow: lint, typecheck, unit tests.

### Commands

| Command          | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `pnpm dev`       | API on port 3000, web on 5173, shared package rebuilt on change |
| `pnpm test`      | All tests. Needs local Postgres (`movies_test`) and Redis       |
| `pnpm test:unit` | Tests that need no services. This is what CI runs               |
| `pnpm lint`      | ESLint                                                          |
| `pnpm typecheck` | TypeScript in every package                                     |
| `pnpm build`     | Builds every package                                            |
| `pnpm db:migrate`| Applies pending migrations to `DATABASE_URL`                    |

Integration tests are the files named `*.int.test.ts`.

### Checked

| Check                                                    | Result                                            |
| -------------------------------------------------------- | ------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`              | Pass                                              |
| `pnpm test` (unit and integration)                       | 25 tests pass (3 shared, 22 API)                  |
| `pnpm db:migrate` on `movies`                            | 1 applied; a second run applies 0                 |
| Migration integration tests on `movies_test`             | Pass                                              |
| API started with `DATABASE_URL` empty                    | Exits with code 1 and "DATABASE_URL is required"  |
| `/api/health` through the Vite proxy, Redis stopped      | 503; Postgres ok, pgvector 0.8.7, Redis unreachable |
| `/api/health` through the Vite proxy, everything running | 200; Postgres ok, pgvector 0.8.7, Redis ok        |
| Status page looked at in a browser                       | Not yet: open http://localhost:5173 under `pnpm dev` |
| GitHub Actions workflow                                  | Not run yet: runs on the first push               |

Local versions: Node 24.21.0, pnpm 12.8.1, PostgreSQL 18.6, pgvector 0.8.7, Redis 8.10.2.

### Left to confirm

- Push the branch and confirm the CI run passes.

### Notes

- This machine has two Homebrews. The `brew` on the `PATH` is the Intel build
  under `/usr/local`; Postgres 18 and pgvector come from it. It has no prebuilt
  packages for current formulae, so `brew install redis` there compiles LLVM
  and Rust from source. Redis was installed with the native one instead:
  `/opt/homebrew/bin/brew install redis`, started with
  `/opt/homebrew/bin/brew services start redis`. Use that one for DuckDB in
  Phase 1 too.
- pnpm holds back packages published in the last day. Express resolved to 5.2.1
  and `@types/node` to 24.19.1 for that reason, instead of versions released on
  2026-10-09.
- `esbuild` is the only dependency allowed to run an install script
  (`allowBuilds` in `pnpm-workspace.yaml`). `tsx` needs it.
- The shared package is compiled to `dist`, and the root scripts build it first.

### Deferred

- Request IDs, rate limits, graceful shutdown and log redaction: Phase 8.
- Web tests: none yet. The page is one fetch; tests come with the search page in Phase 3.
- Integration tests in CI: Phase 11, with service containers.
