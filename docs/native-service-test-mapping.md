# Managed-service migration coverage

Daymark targets Neander. Better Auth and Resend are replaced by native Identity
Platform/Firebase and SES integrations. The existing application journeys remain
the regression baseline; the provider change does not justify dropping bookings,
authorization, persistence or keyboard/mobile checks.

| Prior assertion | Replacement or retained assertion |
| --- | --- |
| Seeded-host browser password login | The official Auth emulator creates the same fictional host UID. The actual login form uses the Firebase web SDK and server session-cookie endpoint. |
| Signup fixture for owner/cross-owner journeys | Native Firebase signup and session exchange establish the same isolated host context before the unchanged domain journeys. |
| Anonymous and tampered session denial | The native session suite checks missing/tampered cookies and rejects the former database-password HTTP route. |
| Name/timezone validation and persistence | Exercise the existing authenticated profile API; keep invalid/offset timezones, blank/long names, normalized names and persisted updates. |
| CSRF and logout | Reject cross-origin session/profile mutations and reject replay of the captured cookie after logout deletes its hashed application session record. |
| Seed retries preserve passwords | SQL seed no longer creates credentials. Retry it and verify the native fixture identity still accepts its original password; keep edited/deleted rows and restart persistence assertions. |
| Resend accepted/pending/retry state | Native SES success, definitive rejection/rate-limit response and unconfirmed transport outcome. SES has no idempotency key: an ambiguous send remains unknown and is not automatically resent. |
| Public booking, conflicts, cancellation/rescheduling, contacts, polls, one-off links | Retain the real PostgreSQL/image/browser assertions and historical-data migration test. |
| Optional Google Calendar authorization and busy-time coverage | Retain its isolated provider fixtures. This is separate from the four automatic managed services and is not advertised as provisioned. |
| No previous storage/reminder implementation | Add actual profile-photo upload/read/isolation and Scheduler create/update/delete assertions; verify real provider use in a fresh Neander preview and published app. |

Official emulators, fictional provider fixtures and disposable databases are test
infrastructure. Passing those checks is not proof of managed cloud provisioning.
The run report must separately record actual new-project preview/publication and
native provider acceptance, including remaining blockers.
