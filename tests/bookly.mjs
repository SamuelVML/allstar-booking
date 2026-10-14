// Contract tests against SQLite-backed D1 and a replay-aware Bookly HTTP double.
// This does not prove WordPress/Bookly execution, Access or payment delivery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, createHash } from 'node:crypto';
import ts from 'typescript';
// Relative dates keep these fixtures in the future; activation skips history.
const amsterdamDay = offset => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Amsterdam',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+offset*86400000));
const D1 = amsterdamDay(21); const D2 = amsterdamDay(22); const SCOPE = amsterdamDay(-7);
const require = createRequire(import.meta.url);
const db = new DatabaseSync(':memory:');
for (const name of fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`drizzle/${name}`, 'utf8'));
const database = {
  prepare(sql) { let values=[]; return { bind(...v){values=v;return this;}, async first(){return db.prepare(sql).get(...values)??null;},
    async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...values).changes)}};}};},
  async batch(statements){db.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},
};
const env={};let requests=0;let refundCalls=0;let loseReceipt=false;let incomplete=false;let conflict=false;
const remote=new Map();const receipts=new Map();let nextId=100;
const version = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');
const sample={remoteId:'7',localId:null,kind:'appointment',version:'a'.repeat(64),serviceId:'haircut',serviceName:'Haircut',date:D1,time:'10:03',endDate:D1,endTime:'10:33',durationMinutes:30,extraMinutes:10,status:'confirmed',customerName:'Amaury customer',customerEmail:'a@example.com',customerPhone:'123456789',notes:'',priceCents:3500,paid:true,group:false};
async function fakeFetch(url, options){
  requests++;
  const route = new URL(url).pathname.replace('/wp-json','');
  const h=options.headers;
  assert.equal(h['X-Allstar-Signature'],createHmac('sha256',env.BOOKLY_BRIDGE_SECRET).update(`${h['X-Allstar-Timestamp']}\n${h['X-Allstar-Nonce']}\n${route}\n${options.body}`).digest('hex'));
  assert.equal(options.redirect,'error');
  const input=JSON.parse(options.body);
  if(route.endsWith('/snapshot'))return Response.json({complete:!incomplete,scopeFrom:SCOPE,appointments:[...remote.values()]});
  if(route.endsWith('/availability'))return Response.json({days:input.days.map(day=>({...day,times:day.times.filter(t=>t!=='11:00')}))});
  if(route.endsWith('/command')){
    if(conflict)return Response.json({error:'conflict'},{status:409});
    if(receipts.has(input.id)){
      assert.equal(receipts.get(input.id).body,options.body,'retries must preserve the exact payload');
      return Response.json(receipts.get(input.id).result);
    }
    const existing=[...remote.values()].find(r=>r.localId===input.localId);
    if(existing&&existing.version!==input.expectedVersion)return Response.json({error:'stale'},{status:409});
    const id=existing?.remoteId??String(nextId++);
    const s=input.state;
    const row={...sample,remoteId:id,localId:input.localId,kind:input.kind,version:version(s),serviceId:s.serviceId,date:s.date,time:s.time,endDate:s.date,
      endTime:`${String(Math.floor((Number(s.time.slice(0,2))*60+Number(s.time.slice(3))+s.durationMinutes)/60)).padStart(2,'0')}:${String((Number(s.time.slice(3))+s.durationMinutes)%60).padStart(2,'0')}`,
      durationMinutes:s.durationMinutes,extraMinutes:s.handlingMinutes,status:['payment_expired','removed'].includes(s.status)?'cancelled':s.status,
      customerName:s.customerName,customerEmail:s.customerEmail,customerPhone:s.customerPhone,notes:s.notes};
    remote.set(id,row);
    const result={remoteId:id,version:row.version};receipts.set(input.id,{result,body:options.body});
    if(loseReceipt){loseReceipt=false;throw new Error('Response lost after commit');}
    return Response.json(result);
  }
  throw new Error('Unexpected request');
}
const modules=new Map();
function load(relative){const filename=path.resolve(relative);if(modules.has(filename))return modules.get(filename).exports;const m={exports:{}};modules.set(filename,m);
 const code=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module:m,exports:m.exports,console,crypto,TextEncoder,TextDecoder,URL,Request,Response,Headers,AbortSignal,Date,Error,fetch:fakeFetch,
 require(name){if(name==='cloudflare:workers')return {env};if(name==='@/lib/refunds')return {async refundCancelledBooking(_db,row){if(row.payment_method==='stripe'&&row.payment_status==='paid')refundCalls++;return 'not_needed';},recordRefundDue:db=>db.prepare('SELECT 1'),async retryDueRefunds(){}};
 if(name==='@/db')return {getD1:()=>database};if(name.startsWith('@/'))return load(name.slice(2)+'.ts');return require(name);}});return m.exports;}
const bridge=load('lib/bookly.ts');
await bridge.synchronizeBookly(database);assert.equal(requests,0,'disabled integration makes no external call');
Object.assign(env,{BOOKLY_SYNC_ENABLED:'true',BOOKLY_BRIDGE_URL:'https://bookly.example/wp-json/allstar-bookly/v1',BOOKLY_BRIDGE_SECRET:'x'.repeat(40)});
remote.set(sample.remoteId,sample);
await bridge.synchronizeBookly(database);
assert.equal(db.prepare("SELECT source FROM appointments WHERE id='bookly-7'").get().source,'bookly');
assert.equal(db.prepare("SELECT payment_status FROM appointments WHERE id='bookly-7'").get().payment_status,'managed_in_bookly');
assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_occupied_slots WHERE slot_start=?").get(`${D1}T10:00`).n,1,'off-grid starts block the preceding grid cell');
assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_occupied_slots WHERE slot_start=?").get(`${D1}T10:40`).n,1,'buffer and partial grid tail block conservatively');
assert.equal(receipts.size,0,'native Bookly rows are never echoed back');
const filtered=await bridge.filterBooklyTimes('haircut',40,[{date:D1,times:['11:00','11:05']}]);
assert.equal(JSON.stringify(filtered[0].times),JSON.stringify(['11:05']));
console.log('PASS: opt-in, signed requests, native import, external payment ownership, conservative slots and live schedule filtering');
const id=crypto.randomUUID();
db.prepare(`INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone,handling_minutes) VALUES (?, 'AS-TEST','haircut','Haircut',30,3500,'${D1}','11:00','11:30','Web customer','web@example.com','123456789',10)`).run(id);
loseReceipt=true;
await assert.rejects(()=>bridge.synchronizeBookly(database),/could not be reached/);
assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status='pending'").get().n,1);
assert.equal([...remote.values()].filter(r=>r.localId===id).length,1);
await bridge.synchronizeBookly(database);
assert.equal([...remote.values()].filter(r=>r.localId===id).length,1,'lost receipt replay creates no duplicate');
assert.equal(db.prepare("SELECT COUNT(*) n FROM bookly_commands WHERE status='pending'").get().n,0);
const linked=[...remote.values()].find(r=>r.localId===id);
linked.time='12:00';linked.endTime='12:30';linked.version='b'.repeat(64);
await bridge.synchronizeBookly(database);
assert.equal(db.prepare('SELECT start_time FROM appointments WHERE id=?').get(id).start_time,'12:00');assert.equal(refundCalls,0,'rescheduling does not refund');
db.prepare("UPDATE appointments SET payment_method='stripe',payment_status='paid',stripe_checkout_session_id='cs_test' WHERE id=?").run(id);
await bridge.synchronizeBookly(database);
linked.version=remote.get(linked.remoteId).version;const paidRemote=remote.get(linked.remoteId);paidRemote.status='cancelled';paidRemote.version='c'.repeat(64);
await bridge.synchronizeBookly(database);
assert.equal(db.prepare('SELECT status FROM appointments WHERE id=?').get(id).status,'cancelled');assert.equal(refundCalls,1);
await bridge.synchronizeBookly(database);assert.equal(refundCalls,1,'same cancellation snapshot is not refunded twice');
console.log('PASS: persistent replay after lost response, no duplicates, Bookly reschedule, Stripe cancellation refund once');
incomplete=true;
await assert.rejects(()=>bridge.synchronizeBookly(database));
assert.equal(db.prepare("SELECT status FROM appointments WHERE id='bookly-7'").get().status,'confirmed','incomplete snapshot never implies deletion');incomplete=false;
remote.get('7').time='10:10';remote.get('7').endTime='10:40';remote.get('7').version='d'.repeat(64);
await bridge.synchronizeBookly(database);
assert.equal(db.prepare("SELECT start_time FROM appointments WHERE id='bookly-7'").get().start_time,'10:10');
// A local edit and a remote edit of the same mapped booking must hold, not overwrite.
const id2=crypto.randomUUID();db.prepare(`INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone) VALUES (?,'AS-OTHER','haircut','Haircut',30,3500,'${D2}','11:00','11:30','Other','other@example.com','123456789')`).run(id2);
await bridge.synchronizeBookly(database);
db.prepare("UPDATE appointments SET start_time='11:15',end_time='11:45',revision=revision+1 WHERE id=?").run(id2);
const other=[...remote.values()].find(r=>r.localId===id2);other.time='12:00';other.endTime='12:30';other.version='e'.repeat(64);
// Held for staff reconciliation without stopping the run (release audit finding 3).
await bridge.synchronizeBookly(database);
assert.equal(db.prepare('SELECT start_time FROM appointments WHERE id=?').get(id2).start_time,'11:15');
assert.match(db.prepare('SELECT reason FROM bookly_conflicts WHERE local_id=?').get(id2).reason,/Both calendars changed/);
assert.equal(db.prepare('SELECT lease_until FROM bookly_sync_state').get().lease_until,0,'errors release the lease');
db.prepare('UPDATE bookly_sync_state SET lease_until=?').run(Date.now()+50000);
await assert.rejects(()=>bridge.synchronizeBookly(database),/in progress/);
db.prepare('UPDATE bookly_sync_state SET lease_until=0').run();
console.log('PASS: incomplete snapshots fail closed, native updates, competing-edit hold and synchronization lease');
const callback=load('app/api/bookly/sync/route.ts');
assert.equal((await callback.POST(new Request('https://worker.example/api/bookly/sync',{method:'POST',body:'{}'}))).status,403);
console.log('PASS: unsigned scheduler callback rejected before synchronization');
db.close();
