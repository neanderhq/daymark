// One owned Toxiproxy route for the existing lost-provider-reply regression.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const exec=promisify(execFile);
const image='ghcr.io/shopify/toxiproxy:2.9.0@sha256:b44c283298cea49e2defaba1b3028783798346f2a926684e3a345fd8441af3b8';

export async function mailTransport(upstreamPort) {
  const name='daymark-mail-transport-'+randomUUID().slice(0,12);
  let control;
  const stop=async()=>{await exec('docker',['rm','--force',name]).catch(()=>{});};
  try {
    await exec('docker',['run','--detach','--name',name,'--label','neander-verification=daymark-native-transport',...(process.platform==='linux'?['--add-host','host.docker.internal:host-gateway']:[]),
      '--publish','127.0.0.1::8474','--publish','127.0.0.1::8666',image],{timeout:60_000});
    const port=async(containerPort)=>Number((await exec('docker',['port',name,containerPort+'/tcp'])).stdout.trim().split(':').at(-1));
    control='http://127.0.0.1:'+await port(8474);
    const proxyPort=await port(8666);
    let ready=false;
    for(let i=0;i<40;i++){try{if((await fetch(control+'/version')).ok){ready=true;break;}}catch{}await delay(250);}
    assert.ok(ready,'Toxiproxy is required; no fake transport fallback');
    const api=async(method,path,body)=>{
      const r=await fetch(control+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
      assert.ok(r.ok||(method==='DELETE'&&r.status===404),'Owned Toxiproxy operation failed: '+method+' '+path+' '+r.status);
    };
    await api('POST','/proxies',{name:'mail',listen:'0.0.0.0:8666',upstream:'host.docker.internal:'+upstreamPort,enabled:true});
    const origin='http://127.0.0.1:'+proxyPort;
    assert.equal((await fetch(origin+'/fixture-probe',{signal:AbortSignal.timeout(5000)})).status,200,'Provider route must work before fault injection');
    return { appOrigin:'http://'+(process.platform==='darwin'?'host.docker.internal':'127.0.0.1')+':'+proxyPort,
      async loseReplies(){
        await api('POST','/proxies/mail/toxics',{name:'lost_reply',type:'limit_data',stream:'downstream',toxicity:1,attributes:{bytes:1}});
        await assert.rejects(fetch(origin+'/fixture-probe',{signal:AbortSignal.timeout(5000)}),'A real client must fail through the toxic');
      },
      async restore(){await api('DELETE','/proxies/mail/toxics/lost_reply');},
      async close(){try{await api('DELETE','/proxies/mail');}finally{await stop();}},
    };
  }catch(error){await stop();throw error;}
}
