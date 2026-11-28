# Managed capabilities

Daymark is a Neander application. Its supported services are declared in
[`.neander/compose.yaml`](.neander/compose.yaml) and implemented with native SDKs:

| Capability | Application implementation |
| --- | --- |
| Authentication | Identity Platform/Firebase host sign-in and tenant session cookies |
| Storage | Private GCS profile photos scoped to the signed-in host |
| Email | SES booking confirmation, reschedule and cancellation messages |
| Scheduling | Scheduler invokes the declared reminder Lambda before a meeting |
| Database | Neander-provisioned Postgres with committed Drizzle migrations |

Neander fills the runtime bindings for Preview and Publish. App builders do not
supply cloud credentials or maintain another provider setup. The remaining
Drizzle/tRPC example files are source references, not alternative deployment or
authentication modes. Optional Google Calendar availability integration is a
separate existing feature; it is not one of the automatically provisioned services.

See [the contract](docs/template-onboarding.md), [development](docs/development.md)
and [coverage mapping](docs/native-service-test-mapping.md). Local emulators and
disposable databases are verification fixtures only.
