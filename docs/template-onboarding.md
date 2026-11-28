# Daymark template contract

Daymark targets Neander exclusively under the existing catalog ID `calendly` and
library title **Scheduling**. The source repository is `neanderhq/daymark`.
The MIT license and historical migrations remain unchanged by this policy.

## Source facts

`.neander/template.yaml` supplies catalog metadata, screenshots, verification and
seed commands. `.neander/compose.yaml` declares runtime contract v2, the web
service's auth/storage/email/scheduling requirements and the Node 22
`booking-reminder` function. The function needs email; its origin binds to
`public_origin`. The web service's reminder ARN binds to that declared function.

Preview and Publish consume these committed declarations. Neander provisions
project/environment-owned resources and supplies native SDK bindings, a database
URL, the public origin and the generated application secret. The clone does not
ask its user for cloud credentials, select alternative providers or implement a
second deployment path. Publishing uses the committed `nextjs-drizzle` migration
recipe before rollout; neither image build nor app startup migrates the database.

## Fictional data and real identities

The retry-safe SQL seed creates Maya Chen and fictional scheduling records using
reserved `example.invalid` addresses. It creates no authentication account,
password or cloud resource. A real app owner signs up through `/signup` using the
managed identity service and receives their own host profile. Seed retries keep
existing edits and deletions. No source-project data is copied into a new app.

## Verification and release

Use the pinned versions in `mise.toml`, run `pnpm verify`, then the built-image
suite documented in [testing](testing.md). Native authentication is exercised
through the official Firebase Auth emulator; local Postgres and provider fixtures
are disposable verification infrastructure. The suite checks the image, actual
browser flows, session security, database persistence, email outcomes, reminder
reconciliation and historical migrations. It cleans up the resources it owns.
Local/CI results do not establish cloud provisioning or a successful publication.

The existing trusted Neander template release pipeline validates the exact source
commit, builds/verifies the image and promotes the release through its normal
review process. A v2 recipe requires the shared contract tooling that supports
managed-service and function declarations. Do not bypass that checker or replace
a catalog release with an unreviewed branch. Record fresh-project Preview and
Publish acceptance separately from source and CI evidence.

Committed thumbnails and gallery screenshots must show the actual app with
fictional data. Ordinary tests write evidence to ignored paths and do not rewrite
the catalog artwork.
