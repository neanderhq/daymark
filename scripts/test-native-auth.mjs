// Official Firebase Auth emulator, scoped to this disposable test run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeApp as adminApp, deleteApp as deleteAdminApp } from 'firebase-admin/app';
import { getAuth as adminAuth } from 'firebase-admin/auth';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';

const require = createRequire(import.meta.url);
async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

export async function startAuthEmulator() {
  const directory = await mkdtemp(join(tmpdir(), 'daymark-auth-'));
  const ports = await Promise.all([unusedPort(), unusedPort(), unusedPort()]);
  const projectId = 'demo-daymark-' + randomUUID().slice(0, 8);
  const configFile = join(directory, 'firebase.json');
  await writeFile(configFile, JSON.stringify({ emulators: {
    auth: { host: '127.0.0.1', port: ports[0] }, hub: { host: '127.0.0.1', port: ports[1] },
    logging: { host: '127.0.0.1', port: ports[2] }, ui: { enabled: false }, singleProjectMode: true,
  } }));
  const log = await open(join(directory, 'emulator.log'), 'w', 0o600);
  const child = spawn(process.execPath, [require.resolve('firebase-tools/lib/bin/firebase.js'), 'emulators:start', '--only', 'auth', '--project', projectId, '--config', configFile], {
    cwd: directory, env: { ...process.env, CI: 'true', FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true' }, stdio: ['ignore', log.fd, log.fd],
  });
  const origin = 'http://127.0.0.1:' + ports[0];
  const closeProcess = async () => {
    if (child.exitCode === null) { child.kill('SIGINT'); await once(child, 'exit'); }
    await log.close(); await rm(directory, { recursive: true, force: true });
  };
  try {
    let ready = false;
    for (let index = 0; index < 120; index++) {
      if (child.exitCode !== null) throw new Error('Firebase Auth emulator exited: ' + (await readFile(join(directory, 'emulator.log'), 'utf8')).slice(-2500));
      try { if ((await fetch(origin + '/emulator/v1/projects/' + projectId + '/config')).ok) { ready = true; break; } } catch {}
      await delay(250);
    }
    assert.ok(ready, 'Official Firebase Auth emulator must be available; no fake fallback');
    const prior = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:' + ports[0];
    const app = adminApp({ projectId }, projectId);
    const tenant = await adminAuth(app).tenantManager().createTenant({ displayName: 'Daymark isolated verification', emailSignInConfig: { enabled: true, passwordRequired: true } });
    const environment = { NEANDER_AUTH_PROJECT_ID: projectId, NEANDER_AUTH_TENANT_ID: tenant.tenantId,
      NEANDER_AUTH_API_KEY: 'daymark-emulator-api-key', NEANDER_AUTH_DOMAIN: projectId + '.firebaseapp.com',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:' + ports[0], DAYMARK_TEST_AUTH_EMULATOR_URL: origin,
    };
    return { environment, runtimeEnvironment: { ...environment,
      FIREBASE_AUTH_EMULATOR_HOST: (process.platform === 'darwin' ? 'host.docker.internal' : '127.0.0.1') + ':' + ports[0],
    }, auth: adminAuth(app).tenantManager().authForTenant(tenant.tenantId),
    async close() {
      await deleteAdminApp(app);
      if (prior === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST; else process.env.FIREBASE_AUTH_EMULATOR_HOST = prior;
      await closeProcess();
    } };
  } catch (error) { await closeProcess(); throw error; }
}

export async function nativeLogin(context, origin, credentials, create = false) {
  const response = await context.get(origin + '/api/auth/managed');
  assert.equal(response.status(), 200, await response.text());
  const config = await response.json();
  assert.ok(config.emulatorUrl && new URL(config.emulatorUrl).hostname === '127.0.0.1', 'Fixture login is limited to an official local emulator');
  const app = initializeApp(config, randomUUID());
  try {
    const auth = getAuth(app); auth.tenantId = config.tenantId;
    connectAuthEmulator(auth, config.emulatorUrl, { disableWarnings: true });
    const signed = await (create ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, credentials.email, credentials.password);
    const result = await context.post(origin + '/api/auth/managed', { headers: { origin }, data: {
      idToken: await signed.user.getIdToken(), name: credentials.name, timezone: credentials.timezone ?? 'UTC',
    } });
    assert.equal(result.status(), 200, await result.text());
    await signOut(auth);
    return { user: { id: signed.user.uid } };
  } finally { await deleteApp(app); }
}
