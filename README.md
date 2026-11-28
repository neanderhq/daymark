# Daymark

A Neander scheduling clone with private host dashboards and public booking pages.
Product inspiration: Calendly, with Daymark branding.

## Use in Neander

Choose Daymark from Starter Templates to create a new app. Neander reads
`.neander/compose.yaml` and automatically provisions the app's database,
Identity Platform sign-in, private Google Cloud Storage, SES email and Scheduler
resources. Its declared reminder function is deployed for preview and publishing.
The app builder does not create cloud resources or supply provider credentials.

Create a host account, edit your booking page and availability, then share your
public booking link. Invitees receive booking confirmation/change emails and a
reminder five minutes before the meeting, when booked sufficiently ahead.
Booking receipts retain cancellation, rescheduling and calendar-file downloads.
Hosts can upload a private profile photo in Settings.

Continue editing in the normal Neander project and Publish again to deploy
changes. Each project owns its bindings; preview and published service data are
separate. Updating the clone does not overwrite an existing user's app.

Neander is the sole supported deployment target. There is no standalone Better
Auth/Resend configuration or alternative cloud-provider setup.

## Product features

- Reusable booking pages, availability, buffers and booking limits.
- Public bookings, private receipts, cancellation and rescheduling.
- Meeting polls, one-off links and host-scoped contacts.
- Native managed sign-in and private profile-photo storage.
- Booking lifecycle email and scheduled meeting reminders.
- Calendar-file downloads. Google Calendar OAuth is separate from the four
  managed services and is not automatically provisioned or advertised as ready.

## Source and verification

Next.js/React/TypeScript, PostgreSQL/Drizzle and supported native provider SDKs.
Use Node and pnpm pinned in `mise.toml`. Read [development](docs/development.md),
[testing](docs/testing.md) and the [auth/provider coverage mapping](docs/native-service-test-mapping.md).
Local emulators and disposable databases are verification fixtures, not another
supported hosting setup. Never run seeds or test suites against a customer DB.

The clone retains versioned migrations and fictional sample data. SQL seed does
not create a login credential; a real app host signs up through managed auth.
A new host receives its own booking page and weekday defaults.

`.neander/template.yaml` owns catalog metadata, sample-data initialization and
verification commands. Neander's trusted publisher verifies a pinned Git commit
and registers the tested images. Source changes are not released until normal
review and publication complete. Existing user apps need normal republishing.

## License and security

[MIT](LICENSE). Existing third-party attribution remains applicable.
See [SECURITY.md](SECURITY.md) for vulnerability reporting and security checks.
