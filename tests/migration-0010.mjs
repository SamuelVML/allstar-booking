// Upgrade compatibility for 0010_release_audit_remediation.sql: a database at
// 0009 with live obligation and refund rows keeps every row and value, gains
// the new columns with safe defaults, and enforces the rebuilt constraints.
// The migration sequence 0008 -> 0009 -> 0010 is applied in order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const files = fs.readdirSync('drizzle').filter(name => name.endsWith('.sql')).sort();
const index = name => files.findIndex(file => file.startsWith(name));
assert.ok(index('0008_') >= 0 && index('0009_') === index('0008_') + 1 && index('0010_') === index('0009_') + 1, 'migrations run 0008, 0009, 0010 in order');
const journal = JSON.parse(fs.readFileSync('drizzle/meta/_journal.json', 'utf8')).entries.map(entry => entry.tag);
assert.deepEqual(journal.slice(-3), ['0008_bookly_bridge', '0009_booking_obligations', '0010_release_audit_remediation']);

const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys=ON');
for (const file of files.filter(file => file < '0010_')) db.exec(fs.readFileSync(`drizzle/${file}`, 'utf8'));
db.prepare(`INSERT INTO appointments(id,reference,service_id,service_name,duration_minutes,price_cents,appointment_date,start_time,end_time,customer_name,customer_email,customer_phone)
  VALUES ('a1','AS-1','haircut','Haircut',30,3500,'2026-11-03','10:00','10:30','Customer','c@example.test','0600000000')`).run();
db.prepare(`INSERT INTO booking_changes(id,appointment_id,revision,action,actor_id,previous_date,previous_time) VALUES ('c1','a1',1,'cancel','staff','2026-11-03','10:00'),
  ('c2','a1',2,'reschedule','staff','2026-11-03','10:00'),('c3','a1',3,'reschedule','staff','2026-11-03','11:00')`).run();
// notify/c1 was attempted (attempts > 0) and may have reached Resend; 0009 kept
// no payload, so it cannot be resent safely. notify/c2 was never attempted;
// notify/c3 is done; refund rows are unaffected.
db.prepare(`INSERT INTO booking_obligations(id,appointment_id,change_id,kind,status,attempts,next_attempt_at,outcome,last_error)
  VALUES ('notify/c1','a1','c1','notify','pending',2,123,NULL,'Email not delivered.'),('refund/c1','a1','c1','refund','done',1,0,'refunded',NULL),
  ('notify/c2','a1','c2','notify','pending',0,0,NULL,NULL),('notify/c3','a1','c3','notify','done',1,0,'sent',NULL),
  ('refund/c2','a1','c2','refund','pending',1,456,NULL,'Stripe unavailable')`).run();
db.prepare(`INSERT INTO payment_refunds(id,appointment_id,amount_cents,status,requested_by) VALUES ('refund-a1','a1',3500,'failed','staff')`).run();
const before = db.prepare('SELECT id,appointment_id,change_id,kind,status,attempts,next_attempt_at,outcome,last_error,created_at FROM booking_obligations ORDER BY id').all();

db.exec(fs.readFileSync(`drizzle/${files[index('0010_')]}`, 'utf8'));

const after = db.prepare('SELECT id,appointment_id,change_id,kind,status,attempts,next_attempt_at,outcome,last_error,created_at FROM booking_obligations ORDER BY id').all();
assert.deepEqual(after.filter(row => row.id !== 'notify/c1'), before.filter(row => row.id !== 'notify/c1'), 'every other obligation row survives unchanged');
const attempted = after.find(row => row.id === 'notify/c1');
assert.equal(attempted.status, 'reconcile', 'an attempted email without a stored payload goes to reconciliation, never an automatic resend');
assert.equal(attempted.next_attempt_at, 0); assert.equal(attempted.attempts, 2); assert.match(attempted.last_error, /confirm with the customer/i);
assert.deepEqual(db.prepare('SELECT DISTINCT payload, first_attempt_at FROM booking_obligations').all().map(row => ({ ...row })), [{ payload: null, first_attempt_at: null }]);
assert.deepEqual({ ...db.prepare('SELECT status,attempts,next_attempt_at FROM payment_refunds').get() }, { status: 'failed', attempts: 0, next_attempt_at: 0 }, 'a failed refund becomes due for automatic retry');
assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
db.prepare("UPDATE booking_obligations SET status='reconcile' WHERE id='notify/c2'").run();
assert.throws(() => db.prepare("UPDATE booking_obligations SET status='bogus'").run(), /CHECK constraint/);
assert.throws(() => db.prepare("UPDATE booking_obligations SET kind='sms'").run(), /CHECK constraint/);
assert.throws(() => db.prepare(`INSERT INTO booking_obligations(id,appointment_id,change_id,kind) VALUES ('x','a1','c1','notify')`).run(), /UNIQUE constraint/, 'one obligation per change and kind');
assert.throws(() => db.prepare(`INSERT INTO booking_obligations(id,appointment_id,change_id,kind) VALUES ('y','missing','c-missing','refund')`).run(), /FOREIGN KEY/);
const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='booking_obligations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
assert.deepEqual(indexes, ['booking_obligations_change_kind', 'booking_obligations_due']);
db.prepare(`INSERT INTO bookly_conflicts(local_id,reason) VALUES ('a1','conflict')`).run();
assert.deepEqual({ ...db.prepare('SELECT resolution FROM bookly_conflicts').get() }, { resolution: null }, 'a new conflict is unresolved');
assert.ok(db.prepare('SELECT detected_at FROM bookly_conflicts').get().detected_at);
assert.throws(() => db.prepare("UPDATE bookly_conflicts SET resolution='maybe'").run(), /CHECK constraint/);
console.log('PASS: migration 0010 upgrades a populated 0009 database in order, keeps every row, and enforces the rebuilt constraints');
