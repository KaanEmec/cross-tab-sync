# Cross-Tab-Sync

Open-source (MIT) tab sync between Safari/macOS and Brave/Windows via a self-hosted Go service.

Read first: `docs/ARCHITECTURE.md` (design and decisions), `docs/PROTOCOL.md` (wire contract), `ROADMAP.md` + `versions/` (epics).

## Layout
- `server/` Go 1.27, stdlib `net/http`, `modernc.org/sqlite`, embedded migrations. `cd server && go test ./... && golangci-lint run`.
- `extension/` TypeScript, esbuild, Vitest, pnpm. `cd extension && pnpm test && pnpm build`. Core logic in `src/core` is browser-free and unit tested; `src/adapter` wraps `chrome.*`.
- `safari/` Xcode wrapper generated from `extension/dist/safari`.
- `deploy/` Docker Compose + Caddy.

## Rules
- Keep it lean: no frameworks, no abstractions without a second concrete use.
- Changes to behavior go through `docs/PROTOCOL.md` first; keep docs short and current.
- Never log URLs or tokens.
- Deletion of shared tabs happens only through explicit `close` operations.
- Tests accompany every core and server change.
