import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

const scope = 'https://www.googleapis.com/auth/calendar.freebusy';

export async function controlledProviders() {
  const state = {
    mail: 'ok', calendar: 'ok', revoked: false, busy: [], deliveries: new Map(), attempts: [], busyRequests: [],
    exchanged: 0, refreshed: 0,
  };
  const codes = new Map();
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      if (request.url === '/resend/emails') {
        assert.equal(request.headers.authorization, 'Bearer fictional-resend');
        const key = request.headers['idempotency-key'];
        assert.match(key, /^daymark\/[0-9a-f-]+$/);
        const payload = JSON.parse(raw);
        state.attempts.push({ key, payload });
        const existing = state.deliveries.get(key);
        if (existing) {
          assert.deepEqual(existing.payload, payload);
          return send(200, { id: existing.id });
        }
        if (state.mail === 'unavailable') return send(503, {});
        const id = randomUUID();
        state.deliveries.set(key, { id, payload });
        if (state.mail === 'ambiguous') return response.destroy();
        return send(200, { id });
      }
      if (request.url === '/google/token') {
        const body = new URLSearchParams(raw);
        assert.equal(body.get('client_id'), 'fictional-google-client');
        assert.equal(body.get('client_secret'), 'fictional-google-secret');
        if (body.get('grant_type') === 'refresh_token') {
          state.refreshed++;
          assert.equal(body.get('refresh_token'), 'fixture-refresh');
          if (state.revoked) return send(400, { error: 'invalid_grant' });
          return send(200, { access_token: 'fixture-access', expires_in: 3600 });
        }
        assert.equal(body.get('grant_type'), 'authorization_code');
        const request = codes.get(body.get('code'));
        assert.ok(request, 'Unknown or replayed provider code');
        assert.equal(body.get('redirect_uri'), request.redirectUri);
        assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), request.challenge);
        codes.delete(body.get('code'));
        state.exchanged++;
        return send(200, { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope });
      }
      if (request.url === '/google/free-busy') {
        assert.equal(request.headers.authorization, 'Bearer fixture-access');
        const { timeMin, timeMax, items } = JSON.parse(raw);
        assert.deepEqual(items, [{ id: 'primary' }]);
        state.busyRequests.push({ timeMin, timeMax });
        if (state.calendar === 'outage') return send(503, { error: 'provider diagnostics remain private' });
        const busy = state.busy.filter(({ start, end }) => end > timeMin && start < timeMax);
        return send(200, { calendars: { 'private-provider-address@example.invalid': { busy } } });
      }
      send(404, {});
    } catch (error) {
      console.error('Controlled provider assertion:', error.message);
      send(500, {});
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    state,
    origin: `http://${process.platform === 'darwin' ? 'host.docker.internal' : '127.0.0.1'}:${server.address().port}`,
    issueCode(authorization) {
      assert.equal(authorization.pathname, '/google/authorize');
      assert.equal(authorization.searchParams.get('scope'), scope);
      assert.equal(authorization.searchParams.get('access_type'), 'offline');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      const code = randomUUID();
      codes.set(code, { redirectUri: authorization.searchParams.get('redirect_uri'), challenge: authorization.searchParams.get('code_challenge') });
      return code;
    },
    close() { server.close(); },
  };
}
