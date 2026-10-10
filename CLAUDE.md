# Movie Recommendation Engine

Read PLAN.md, DECISIONS.md and docs/PROGRESS.md at the start of every session.
Work only on the current phase. Update docs/PROGRESS.md and commit at the end of each phase.

## Rules

- The database decides which movies exist. Drop any LLM movie ID not in the candidate list.
- Validate all LLM output with Zod. Only apps/api/src/llm imports the Gemini SDK.
- Tests use the fake provider, never the real Gemini API.
- No hard-coded model names, dimensions, thresholds or weights. Use config.
- Hand-written SQL, no ORM. Express 5 for the API.
- Record new decisions in DECISIONS.md. Ask before significant ones.
- Never put API keys in the web app, git or logs.

## Commands

- pnpm dev / test / lint / typecheck / build / db:migrate
- Local services: Homebrew Postgres 18 (pgvector) and Redis

## Git

- Never run git commands that change the repo (commit, push, pull, merge, rebase,
  reset, checkout, switch, branch, stash, tag). The user does all git work to learn it.
- Read-only is fine: git status, git diff, git log.
- When a step is done, list the changed files and suggest a Conventional Commits message.
