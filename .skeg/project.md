# Project

## Stack
- Node.js 24, CommonJS JavaScript, Express 5, EJS 6
- SQLite via better-sqlite3
- node:test for server tests; Playwright for HTML, browser, and visual checks

## Commands
- test: `npm test`
- targeted test: `node --test test/<name>.test.js`
- HTML snapshots: `npm run test:html-snapshots`
- visual/browser: `npm run test:visual` / `npm run test:article-audio-browser`
- typecheck: `npm run typecheck` (analytics JavaScript scope)
- lint: `npm run lint` (analytics implementation and regression tests)

## Boundaries
- Do not edit generated/runtime data: `blog.db`, `articles/`, `uploads/`, `backups/`, `public/images/`, `test-results/`.
- Database/schema changes require guarded mode and explicit approval.
- Public API, dependency, authentication, deployment, and production-config changes require a gate.
- Preserve pre-existing workspace changes; do not revert unrelated work.

## Conventions
- Follow existing CommonJS and Express router/module patterns.
- Prefer existing abstractions and Chinese user-facing copy.
- Add focused `node:test` regressions for bug fixes; add Playwright coverage for interaction or visual changes.
