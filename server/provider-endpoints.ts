export function providerEndpoint(canonical: string, testPath: string): string {
  const configured = (testPath === "/ses" ? process.env.DAYMARK_TEST_SES_ORIGIN : undefined) || process.env.DAYMARK_TEST_PROVIDER_ORIGIN;
  const appOrigin = process.env.DAYMARK_APP_URL;
  if (!configured || !appOrigin) return canonical;

  // The built-image suite routes fictional credentials to a local test server.
  // The override does not apply to a hosted app.
  const app = URL.parse(appOrigin);
  const override = URL.parse(configured);
  if (app && override && app.protocol === "http:" && ["127.0.0.1", "localhost"].includes(app.hostname)
    && override.protocol === "http:" && ["127.0.0.1", "localhost", "host.docker.internal"].includes(override.hostname)) {
    return new URL(testPath, override.origin).href;
  }
  return canonical;
}
