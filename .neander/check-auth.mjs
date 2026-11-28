// Native session and profile regression against the built image and official emulator.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {request} from '@playwright/test';
import {Client} from 'pg';
import {nativeLogin} from '../scripts/test-native-auth.mjs';

const origin=new URL(process.argv[2]).origin;
assert.equal(new URL(origin).protocol,'http:');
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname));
assert.equal(process.env.DATABASE_URL,process.env.NEANDER_TEMPLATE_TEST_DATABASE_URL);
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
const context=await request.newContext({baseURL:origin,extraHTTPHeaders:{origin}});
let id;
try{
 const signed=await nativeLogin(context,origin,{name:'Session test',email:randomUUID()+'@example.invalid',password:'Fictional-'+randomUUID(),timezone:'UTC'},true);
 id=signed.user.id;
 const state=await context.storageState();
 const native=state.cookies.find(value=>value.name.startsWith('daymark.'));
 assert.ok(native.httpOnly);assert.equal(native.sameSite,'Lax');
 const cookie=state.cookies.map(value=>value.name+'='+value.value).join('; ');
 assert.equal((await fetch(origin+'/api/me')).status,401);
 assert.equal((await fetch(origin+'/api/me',{headers:{cookie:cookie+'tampered'}})).status,401);
 assert.equal((await context.get('/api/me')).status(),200);
 assert.equal((await context.post('/api/auth/sign-in/email',{data:{email:'fixture@example.invalid',password:'unused'}})).status(),404,'Old database-password route must stay unavailable');
 assert.equal((await context.post('/api/auth/managed',{headers:{origin:'https://attacker.invalid'},data:{}})).status(),403);
 const stored=async()=> (await db.query('SELECT name,email,timezone FROM "user" WHERE id=$1',[id])).rows[0];
 const profile=async(values)=>context.patch('/api/profile',{data:{...await stored(),...values}});
 for(const invalid of [{name:'  '},{name:'N'.repeat(81)},{timezone:'Not/AZone'},{timezone:'+01:00'}]){
  const before=await stored();assert.equal((await profile(invalid)).status(),400);assert.deepEqual(await stored(),before);
 }
 assert.equal((await profile({email:'different@example.invalid'})).status(),400,'Sign-in owns the email identity');
 assert.equal((await profile({name:'  Updated Test  ',timezone:'America/La_Paz'})).status(),200);
 assert.equal((await stored()).name,'Updated Test');assert.equal((await stored()).timezone,'America/La_Paz');
 assert.equal((await context.patch('/api/profile',{headers:{origin:'https://attacker.invalid'},data:{name:'Unwanted'}})).status(),403);
 assert.equal((await fetch(origin+'/api/profile/photo',{method:'POST',headers:{origin},body:'not-a-photo'})).status,401);
 assert.equal((await context.post('/api/profile/photo',{data:Buffer.from('<svg></svg>')})).status(),400);
 assert.equal((await context.post('/api/profile/photo',{data:Buffer.alloc(2*1024*1024+1)})).status(),413);
 assert.equal((await context.delete('/api/auth/managed',{headers:{origin:'https://attacker.invalid'}})).status(),403);
 assert.equal((await context.delete('/api/auth/managed')).status(),200);
 assert.equal((await fetch(origin+'/api/me',{headers:{cookie}})).status,401,'Logged-out session cannot be replayed');
 console.log('Native auth: browser-compatible session, anonymous/tampered denial, disabled legacy route, validation, CSRF, upload guards and logout replay passed');
}finally{if(id)await db.query('DELETE FROM "user" WHERE id=$1',[id]);await db.end();await context.dispose();}
