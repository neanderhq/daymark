import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mailTransport } from './test-provider-transport.mjs';

const scope = 'https://www.googleapis.com/auth/calendar.freebusy';

export async function controlledProviders() {
  const state = {
    mail: 'ok', calendar: 'ok', revoked: false, busy: [], deliveries: new Map(), attempts: [], busyRequests: [],
    exchanged: 0, refreshed: 0, schedules:new Map(), scheduleCalls:[],
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
      if (request.url === '/fixture-probe') return send(200, {ok:true});
      const path=new URL(request.url,'http://fixture.invalid');
      if(path.pathname.startsWith('/scheduler/schedules/')){
        assert.match(request.headers.authorization,/^AWS4-HMAC-SHA256 /);
        const name=decodeURIComponent(path.pathname.split('/').at(-1));
        assert.match(name,/^daymark-[0-9a-f]{48}$/);
        const body=raw?JSON.parse(raw):{};
        assert.equal(body.GroupName??path.searchParams.get('groupName'),'fixture-schedules');
        state.scheduleCalls.push({method:request.method,name,body});
        if(request.method==='DELETE'){
          if(!state.schedules.delete(name))return send(404,{__type:'ResourceNotFoundException'});
          return send(200,{});
        }
        assert.equal(body.Target.Arn,'arn:aws:lambda:ap-south-1:123456789012:function:fixture-reminder');
        assert.equal(body.Target.RoleArn,'arn:aws:iam::123456789012:role/fixture-execution');
        assert.equal(body.ActionAfterCompletion,'DELETE');
        assert.deepEqual(body.FlexibleTimeWindow,{Mode:'OFF'});
        if(request.method==='POST'&&state.schedules.has(name))return send(409,{__type:'ConflictException'});
        state.schedules.set(name,body);
        return send(200,{ScheduleArn:'arn:aws:scheduler:ap-south-1:123456789012:schedule/fixture-schedules/'+name});
      }
      if (request.url === '/ses/v2/email/outbound-emails') {
        assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 /);
        assert.equal(request.headers['idempotency-key'], undefined);
        const native=JSON.parse(raw);
        assert.equal(native.FromEmailAddress,'daymark@example.invalid');
        assert.equal(native.ConfigurationSetName,'fixture-config');
        const payload={from:native.FromEmailAddress,to:native.Destination.ToAddresses,subject:native.Content.Simple.Subject.Data,text:native.Content.Simple.Body.Text.Data};
        const key=randomUUID();
        state.attempts.push({ key, payload });
        if (state.mail === 'rate-limited') return send(429, {__type:'TooManyRequestsException',message:'Fictional rate limit'});
        if (state.mail === 'unavailable') return send(503, {});
        const id = randomUUID();
        state.deliveries.set(key, { id, payload });
        return send(200, { MessageId:id });
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
  server.listen(0, process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1');
  await once(server, 'listening');
  let transport;
  try { transport=await mailTransport(server.address().port); }
  catch(error){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw error;}
  return {
    state,
    origin: `http://${process.platform === 'darwin' ? 'host.docker.internal' : '127.0.0.1'}:${server.address().port}`,
    mailOrigin:transport.appOrigin,
    loseMailReplies:()=>transport.loseReplies(),
    restoreMail:()=>transport.restore(),
    issueCode(authorization) {
      assert.equal(authorization.pathname, '/google/authorize');
      assert.equal(authorization.searchParams.get('scope'), scope);
      assert.equal(authorization.searchParams.get('access_type'), 'offline');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      const code = randomUUID();
      codes.set(code, { redirectUri: authorization.searchParams.get('redirect_uri'), challenge: authorization.searchParams.get('code_challenge') });
      return code;
    },
    async close() { await transport.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); },
  };
}
