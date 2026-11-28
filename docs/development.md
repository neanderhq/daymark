# Development and verification

Daymark targets Neander and its native managed services. Keep the Compose v2
contract, declared function, migrations and code together when features change.
Never add provider-selection fallbacks or per-project cloud setup scripts.

Use Node and pnpm from `mise.toml`, then `pnpm install --frozen-lockfile`.
`pnpm verify` runs source checks, unit tests, repository policy and the production
build. `pnpm test:production` exercises the built image with an explicitly
isolated PostgreSQL database and the official Firebase Auth emulator.
The suite supplies fictional credentials and cleans up its own app/emulator.
See `docs/testing.md` and `docs/native-service-test-mapping.md` for coverage.

`.env.example` contains only loopback test-fixture names. Production and preview
bindings are supplied by Neander; do not copy operator credentials into it.
Generate application-schema changes using Drizzle. Preserve existing migration
history and application data when changing authentication. The user/session
metadata tables do not authorize a password sign-in without native verification.

Use feature branches and PRs. Preserve app/runtime/security checks, read-only
public CI credentials and immutable tool/image pins. Keep raw captures, database
URLs and runtime credentials out of Git.
