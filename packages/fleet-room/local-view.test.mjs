import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync, unlinkSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRoomView } from './local-view.mjs';
import { RoomStorage } from './storage.mjs';
import { roomControl } from '../fleet-worker/src/room-control.mjs';

async function fixture(t) {
 const home = mkdtempSync(join(tmpdir(), 'fleet-local-view-'));
 const storage = new RoomStorage(join(home,'leader.sqlite'));
 const rpc = (action,input) => roomControl(storage,{kind:'user',id:'owner'},action,input);
 await rpc('agents.register',{id:'leader',name:'Leader',mode:'runtime',capacity:1});
 await rpc('rooms.create',{id:'room',name:'中文房间',leaderId:'leader',defaultDeviceId:'device'});
 let view;
 const server = http.createServer((req,res)=>void view.handle(req,res));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url = `http://127.0.0.1:${server.address().port}`;
 view = new LocalRoomView({storage,id:'leader',url,fleetHome:home});view.publish();
 const headers={authorization:`Bearer ${view.descriptor.readCapability}`};
 t.after(async()=>{view.close();await new Promise(resolve=>server.close(resolve));await storage.close();rmSync(home,{recursive:true,force:true});});
 return {home,storage,view,url,headers,rpc};
}
test('local read endpoint uses only leader ledger, paginates and is private',async(t)=>{
 const f=await fixture(t);
 await f.rpc('messages.send',{roomId:'room',discussionId:'main',requestId:'one',expectedContextRev:0,text:'中文第一条'});
 await f.rpc('messages.send',{roomId:'room',discussionId:'main',requestId:'two',expectedContextRev:1,text:'second'});
 const descriptor=JSON.parse(readFileSync(f.view.path));
 assert.deepEqual(Object.keys(descriptor).sort(),['instanceId','leaderId','readCapability','url','version']);
 assert.equal(statSync(f.view.path).mode&0o777,0o600);
 assert.equal(statSync(join(f.home,'rooms')).mode&0o777,0o700);
 const rooms=await fetch(f.url+'/rooms',{headers:f.headers});
 assert.equal(rooms.headers.get('cache-control'),'no-store');
 assert.equal((await rooms.json()).rooms[0].name,'中文房间');
 const page=await (await fetch(f.url+'/messages?roomId=room&limit=1',{headers:f.headers})).json();
 assert.equal(page.messages[0].text,'中文第一条');assert.equal(page.hasMore,true);
 const next=await (await fetch(f.url+`/messages?roomId=room&afterSeq=${page.nextCursor}`,{headers:f.headers})).json();
 assert.equal(next.messages[0].text,'second');assert.equal(next.hasMore,false);
 for(const [path,options,status] of [
  ['/rooms',{},403],['/rooms',{headers:{...f.headers,origin:'http://evil.test'}},403],
  ['/rooms',{method:'POST',headers:f.headers},405],
  ['/messages?roomId=room&url=http://evil.test',{headers:f.headers},400],
  ['/messages?roomId=room&limit=101',{headers:f.headers},400]
 ])assert.equal((await fetch(f.url+path,options)).status,status, JSON.stringify(options));
 const hostStatus = await new Promise((resolve,reject)=>{
  const req=http.get(f.url+'/rooms',{headers:{...f.headers,host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);
 });assert.equal(hostStatus,403);
});
test('discovery never overwrites another runner and cleanup removes only its own instance',async(t)=>{
 const f=await fixture(t);
 const duplicate=new LocalRoomView({storage:f.storage,id:'leader',url:f.url,fleetHome:f.home});
 assert.throws(()=>duplicate.publish(),{code:'EEXIST'});duplicate.close();assert.equal(existsSync(f.view.path),true);
 unlinkSync(f.view.path);
 writeFileSync(f.view.path,JSON.stringify({...f.view.descriptor,instanceId:'replacement'}),{mode:0o600});
 f.view.close();assert.equal(existsSync(f.view.path),true);
});

test('home aliases work but a symlinked discovery directory is rejected', async (t) => {
 const root=mkdtempSync(join(tmpdir(),'fleet-local-home-alias-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const home=join(root,'real-home');mkdirSync(home,{mode:0o700});
 const alias=join(root,'home');symlinkSync(home,alias);
 const view=new LocalRoomView({storage:{},id:'leader',url:'http://127.0.0.1:1',fleetHome:join(alias,'.fleet-agent')});
 view.publish();
 assert.equal(existsSync(join(home,'.fleet-agent','rooms','leader.json')),true);
 view.close();
 assert.equal(existsSync(join(home,'.fleet-agent','rooms','leader.json')),false);
 const unsafe=join(root,'unsafe');mkdirSync(unsafe,{mode:0o700});
 symlinkSync(join(home,'.fleet-agent','rooms'),join(unsafe,'rooms'));
 const other=new LocalRoomView({storage:{},id:'other',url:'http://127.0.0.1:1',fleetHome:unsafe});
 assert.throws(()=>other.publish(),/private and owned/);
});

test('display names preserve stable agent identities, role separation and human authors', async (t) => {
 const f = await fixture(t);
 await f.rpc('agents.configure', { agentId: 'leader', name: 'Grok 主会话' });
 for (const id of ['coder-a', 'coder-b']) {
  await f.rpc('agents.register', { id, name: 'Codex', mode: 'runtime', capacity: 1 });
  await f.rpc('rooms.invite', { roomId: 'room', agentId: id });
  await roomControl(f.storage, { kind: 'agent', id }, 'agents.heartbeat', {});
 }
 const send = (principal, requestId, expectedContextRev, extra = {}) => roomControl(f.storage, principal, 'messages.send', {
  roomId: 'room', discussionId: 'main', requestId, expectedContextRev, text: requestId, ...extra,
 });
 await send({ kind: 'agent', id: 'leader' }, 'leader-message', 0);
 await send({ kind: 'agent', id: 'coder-a' }, 'same-name-a', 1, { toAgentId: 'coder-b' });
 await send({ kind: 'agent', id: 'coder-b' }, 'same-name-b', 2);
 await send({ kind: 'user', id: 'coder-a' }, 'human-same-id', 3);
 const rooms = await (await fetch(f.url+'/rooms', { headers: f.headers })).json();
 assert.equal(rooms.rooms[0].leaderId, 'leader');
 assert.equal(rooms.rooms[0].leaderName, 'Grok 主会话');
 const page = await (await fetch(f.url+'/messages?roomId=room', { headers: f.headers })).json();
 assert.deepEqual(page.messages.map(({authorId,authorName,authorKind}) => [authorId,authorName,authorKind]), [
  ['leader','Grok 主会话','agent'], ['coder-a','Codex','agent'], ['coder-b','Codex','agent'], ['coder-a','coder-a','user'],
 ]);
 assert.equal(page.messages[1].toAgentId, 'coder-b');
 assert.equal(page.messages[1].toAgentName, 'Codex');
 assert.equal(Object.hasOwn(page.messages[0], 'toAgentName'), false);
 assert.equal(JSON.stringify({rooms,page}).includes(f.view.descriptor.readCapability), false);
 // Old messages remain intelligible when an agent display record is unavailable.
 await f.storage.transaction((tx) => tx.delete('room-control:agent:coder-b'));
 const fallback = await (await fetch(f.url+'/messages?roomId=room', { headers: f.headers })).json();
 assert.equal(fallback.messages[1].toAgentName, 'coder-b');
 assert.equal(fallback.messages[2].authorName, 'coder-b');
});
