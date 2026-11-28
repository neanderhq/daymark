# Verification

Run `pnpm verify` after [development setup](development.md). This preserves the
existing app tests and build, and adds the common repository policy check.
TypeScript is the existing static gate; this migration does not introduce a new lint ruleset.

## CI gates

- **policy** checks repository identity/files, runtime pins, immutable action pins,
  read-only permissions and the production verification entry point.
- **app** runs the source checks and existing app-specific assertions.
- **Runtime security** (the `production` job) builds the real Docker image,
  scans it with checksum-verified Trivy, initializes a disposable PostgreSQL
  service and runs `pnpm test:production`. The alias preserves `test:template`.
- **Dependency audit**, **Dependency review** and GitHub CodeQL remain required.
  Runtime and dependency scans also run daily. Existing additional deployment
  checks remain in their separate workflow where present.

## Production smoke coverage

Host login, scheduling pages, public bookings/conflicts, seed retries, preserved
edits/deletions/native identities and restart persistence.

The same built-image suite also runs `scripts/test-scorecard-browser.mjs` against
its local server and disposable PostgreSQL database. It creates a fictional host,
then checks event editing; hours, overrides, buffers, notice, horizon and meeting
limits; UTC/Kolkata/New York displays; booking conflicts; host/invitee rescheduling
and cancellation; poll voting/finalization; one-off link consumption; and truthful
Contacts summaries. It completes real bookings at a measured 375px viewport and
with only the keyboard, including required-field/email validation and focus.
The test deletes its own host after the run. No reference-account actions occur.

The milestone suite then exercises migration from the prior schema in an isolated
database and starts the same built image with the official Firebase Auth emulator
and native SES/Scheduler request fixtures. It checks session exchange, logout,
booking email delivery state, stable reminder creation/rescheduling/cancellation,
and an accepted email whose reply is lost through an owned Toxiproxy instance.
An ambiguous SES send stays unknown and is not automatically resent. Existing
optional Google Calendar authorization, cross-owner access, busy-time conflicts,
outage recovery and 375px keyboard checks remain. All fixtures are fictional;
these tests need Docker and no live cloud credentials.

Screenshots and a per-check JSON report are written to `.cache/scorecard/` (ignored),
or `DAYMARK_SCORECARD_EVIDENCE` when set. The milestone suite uses
`.cache/milestone/` or `DAYMARK_MILESTONE_EVIDENCE`. Those are evidence for the checked states,
not a claim of complete Calendly feature parity or physical-device coverage.

CI starts the pinned official Auth emulator, an owned Toxiproxy container and an
isolated local PostgreSQL service. Missing transport tooling is a setup failure;
the tests do not silently substitute fake outages.
`DATABASE_URL` and `NEANDER_TEMPLATE_TEST_DATABASE_URL` must identify the same
explicitly disposable database. Build the image and apply the existing recipe's
migration/seed commands before invoking the smoke suite. `.github/workflows/check.yml`
is the executable setup reference; test credentials there are CI fixtures.
The suite starts/stops its own local app container and writes synthetic records.
Never copy these commands onto an existing customer database.

Passing this CI establishes the assertions in the existing suites, not complete
product acceptance, physical-device/mobile coverage, managed Neon/Cloud Run
deployment, real email delivery or the desktop Neander Publish path. Keep the
README's product-specific limitations and the [coverage mapping](native-service-test-mapping.md). Add regression tests for behavior changes;
do not replace real app checks with boilerplate-only assertions.
