# TMIP Plan 002 — Phase 10: v1.1 Hardening — Linting & Engineering Quality

- **Status:** Approved (owner directive, 2026-10-06)
- **Scope:** Linting infrastructure only. No application behavior, architecture, retry, reprocessing, or v2 feature work.
- **Review basis:** `AGENTS.md` ("23. Technology Stack", "24. Dependency Discipline", "28. Testing Requirements", "29. Implementation Workflow", "36. Definition of Done"), `SCOPE.md`, existing `docs/plans/001-first-vertical-slice.md`.
- **Baseline:** Phases 1–9 complete and verified (97/97 tests pass, typecheck passes, Docker stack accepted). Repo clean at commit `5289106`. No ESLint exists anywhere in the workspace. Node v24.16.0, pnpm 11.23.0, TypeScript 5.9, Next 15.5.

**Mission:** Lint can be run consistently from the repository root for `apps/api` and `apps/web`, with violations fixed without changing behavior.

---

## 1. Requirements (owner directive → concrete deliverables)

| # | Requirement | Deliverable |
|---|---|---|
| R1 | ESLint configuration for `apps/api` and `apps/web` | `apps/api/eslint.config.mjs` (typescript-eslint, ESLint 9 flat config), `apps/web/eslint.config.mjs` (eslint-config-next) |
| R2 | `lint` scripts | `lint` in `apps/api/package.json`, `apps/web/package.json`, and root `package.json` (`pnpm -r run lint`) |
| R3 | Compatibility with TypeScript / Next.js / pnpm / monorepo | Flat-config ESLint 9; parsers reuse each app's `tsconfig`; Next.js plugin config for web |
| R4 | Fix only revealed violations | Behavior-preserving fixes only; no refactors |
| R5 | Run lint from repo root | `pnpm lint` at root works |
| R6 | Documentation update only if required | `AGENTS.md`/`TESTING.md` mention linting "when configured"; if configuration is added, update `TESTING.md` (or the minimal relevant doc) to reflect the new verification step |

## 2. Constraints

- `AGENTS.md` "24. Dependency Discipline": add only ESLint core + typescript-eslint + eslint-config-next; no stylistic/formatting tool (no Prettier), no overlapping plugins.
- Do not modify `.env`, `docker-compose.yml`, Dockerfiles, Prisma schema/migrations, or any runtime source file beyond lint-fix-worthy violations.
- `AGENTS.md` "31. Refactoring Rules": no unrelated reformatting; fixes must be minimal.
- Out of scope (explicit): feature work, retry logic, reprocessing, authentication, v2 scope.

## 3. Implementation steps

1. Create `docs/plans/002-linting-engineering-quality.md` (this document) **before** code changes.
2. Add devDependencies: root `eslint`; api: `eslint`, `typescript-eslint`, `globals`; web: `eslint`, `eslint-config-next`.
3. Add `eslint.config.mjs` per app; api config targets `src/**/*.ts` with type-aware-lite (recommended, non-type-checked to keep lint fast) and respects `dist/**`; web config uses `next/core-web-vitals` via flat config `FlatCompat` or Next's exported flat config.
4. Add `lint` scripts; wire root `pnpm lint`.
5. Run lint, fix revealed violations minimally (e.g. unused imports/vars, `no-explicit-any` if surfaced — fix by proper typing, not by blanket disabling; any necessary `eslint-disable` must carry a justification comment).
6. Update docs if conventions require (R6).

## 4. Verification plan (independent test-engineer)

- `pnpm lint` (root), `pnpm -r run lint` — exit 0.
- `pnpm typecheck`, `pnpm test` — unchanged pass (97/97).
- `pnpm build` — both apps build.
- `git diff` review: only lint-related files + minimal violation fixes; confirm no `.env`, Docker, Prisma, or behavior changes.
- Report: requirement→code mapping, requirement→verification mapping, exact commands + results, diff/stat, files changed, warnings/blockers/deferred, explicit scope confirmation.

## 5. Risks / notes

- `eslint-config-next` and Next 15 flat config compatibility: use the officially documented pattern (`FlatCompat` from `@eslint/eslintrc`, already a transitive dep of eslint-config-next, but declared explicitly).
- BigInt/node globals in api config: declare `globals.node`.
- If lint rules conflict with existing idiomatic code in ways that would force behavior-affecting edits, demote the rule to `warn` in config with a comment — prefer that over refactor (per "31. Refactoring Rules").
