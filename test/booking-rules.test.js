'use strict';
/* Runs the REAL booking-rule functions of server.js (checkSlot, slotMessage, to12h, ...) together with lib/logic.js,
   with a fixed clock, so no database or web server is needed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const logic = require('../lib/logic');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const from = server.indexOf('function todayInDubai()');
const to = server.indexOf('function bookingJson(');
assert.ok(from > 0 && to > from, 'booking-rule section not found in server.js');

// Friday 2026-10-09, 10:00 in Dubai (UTC+4) = 06:00 UTC
const NOW = Date.UTC(2026, 9, 9, 6, 0, 0);
function load(nowMs = NOW) {
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
  }
  const ctx = vm.createContext({ ...logic, Date: FakeDate, PENDING_HOLD_HOURS: 24, MIN_LEAD_HOURS: 3 });
  return vm.runInContext(server.slice(from, to) + '\n({ checkSlot, slotMessage, to12h, addDaysDubai, todayInDubai, holdsSlot })', ctx);
}
// objects created inside the vm have another Object.prototype: compare them as plain JSON
const plain = (o) => JSON.parse(JSON.stringify(o));
const R = load();
const ST = { weekdayOpen: '09:00', weekdayClose: '21:00', fridayOpen: '14:00', fridayClose: '22:00', partyMinutes: 180, maxParallel: 1, maxPerDay: 5 };
const NIGHT = { ...ST, weekdayOpen: '14:00', weekdayClose: '02:00' };
const FRI = '2026-10-09', SAT = '2026-10-10';

test('today and date arithmetic follow Dubai time', () => {
  assert.equal(R.todayInDubai(), '2026-10-09');
  assert.equal(R.addDaysDubai(0), '2026-10-09');
  assert.equal(R.addDaysDubai(1), '2026-10-10');
  assert.equal(R.addDaysDubai(-90), '2026-07-11');
  // 21:00 UTC is already the next day in Dubai
  const late = load(Date.UTC(2026, 9, 9, 21, 0, 0));
  assert.equal(late.todayInDubai(), '2026-10-10');
  assert.equal(late.addDaysDubai(0), '2026-10-10');
});

test('to12h', () => {
  assert.equal(R.to12h('00:05'), '12:05 AM');
  assert.equal(R.to12h('09:00'), '9:00 AM');
  assert.equal(R.to12h('12:00'), '12:00 PM');
  assert.equal(R.to12h('21:00'), '9:00 PM');
});

test('a normal Saturday slot is accepted', () => {
  assert.deepEqual(plain(R.checkSlot(SAT, '10:00', ST, [])), { ok: true });
  assert.deepEqual(plain(R.checkSlot(SAT, '18:00', ST, [])), { ok: true }); // 18:00 + 3 h = 21:00 = closing time
});

test('party that would end after closing is refused, with the closing time in the message', () => {
  const c = R.checkSlot(SAT, '18:30', ST, []);
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'outside');
  assert.match(R.slotMessage(c), /finish before closing time \(9:00 PM\)/);
  assert.equal(R.checkSlot(SAT, '08:30', ST, []).reason, 'outside'); // before opening
});

test('Friday uses Friday hours', () => {
  assert.equal(R.checkSlot('2026-10-16', '10:00', ST, []).reason, 'outside'); // Friday opens 14:00
  assert.deepEqual(plain(R.checkSlot('2026-10-16', '14:00', ST, [])), { ok: true });
  assert.equal(R.checkSlot('2026-10-16', '19:30', ST, []).reason, 'outside'); // 19:30 + 3 h > 22:00
});

test('minimum lead time (3 h) is measured in Dubai time', () => {
  // now = Friday 10:00 Dubai; Friday opens 14:00
  assert.deepEqual(plain(R.checkSlot(FRI, '14:00', ST, [])), { ok: true });           // 4 h ahead
  const soon = load(Date.UTC(2026, 9, 9, 10, 30, 0));                           // now = 14:30 Dubai
  assert.equal(soon.checkSlot(FRI, '16:00', ST, []).reason, 'passed');          // only 1.5 h ahead
  assert.equal(soon.checkSlot(FRI, '17:30', ST, []).ok, true);                  // exactly 3 h ahead
  assert.equal(soon.checkSlot(FRI, '14:00', ST, []).reason, 'passed');          // already started
  assert.match(soon.slotMessage({ reason: 'passed' }), /too soon to book online/);
});

test('double booking: one party at a time by default, more when maxParallel allows', () => {
  const ex = [{ time: '10:00' }];
  const busy = R.checkSlot(SAT, '11:00', ST, ex);
  assert.equal(busy.reason, 'busy');
  assert.match(R.slotMessage(busy), /no longer available/);
  assert.equal(R.checkSlot(SAT, '13:00', ST, ex).ok, true);                     // starts when the other ends
  assert.equal(R.checkSlot(SAT, '11:00', { ...ST, maxParallel: 2 }, ex).ok, true);
  assert.equal(R.checkSlot(SAT, '11:00', { ...ST, maxParallel: 2 }, [{ time: '10:00' }, { time: '10:30' }]).reason, 'busy');
});

test('daily limit: the day is "full" after maxPerDay bookings', () => {
  const five = ['09:00', '12:00', '15:00', '18:00', '09:30'].map((time) => ({ time }));
  const full = R.checkSlot(SAT, '10:00', ST, five.slice(0, 5));
  assert.equal(full.reason, 'full');
  assert.match(R.slotMessage(full), /fully booked/);
  // control: with a higher daily limit the same request is no longer "full" (it is then refused only for overlapping)
  assert.equal(R.checkSlot(SAT, '10:00', { ...ST, maxPerDay: 6 }, five).reason, 'busy');
  assert.equal(R.checkSlot(SAT, '21:00', ST, five).reason, 'outside'); // outside is reported before full
});

test('window that closes after midnight: last start is 23:00 for a 3 h party', () => {
  assert.deepEqual(plain(R.checkSlot(SAT, '14:00', NIGHT, [])), { ok: true });
  assert.deepEqual(plain(R.checkSlot(SAT, '23:00', NIGHT, [])), { ok: true });
  const late = R.checkSlot(SAT, '23:30', NIGHT, []);
  assert.equal(late.reason, 'outside');
  assert.match(R.slotMessage(late), /closing time \(2:00 AM\)/); // close = 1560 min shown as 2:00 AM
  assert.equal(R.checkSlot(SAT, '00:30', NIGHT, []).reason, 'outside'); // 00:30 is after-midnight of the same day: ends 03:30
  assert.equal(R.checkSlot(SAT, '10:00', NIGHT, []).reason, 'outside'); // before 14:00
});

test('holdsSlot(): confirmed bookings and recent pending ones block a slot, old pending ones do not', () => {
  const q = R.holdsSlot();
  assert.equal(q.$or.length, 3);
  assert.deepEqual(plain(q.$or[0]), { status: 'confirmed' });
  const cutoff = NOW - 24 * 3600 * 1000;
  assert.equal(q.$or[1].status, 'pending');
  assert.equal(q.$or[1].createdAt.$gt.getTime(), cutoff);
  assert.equal(q.$or[2].reopenedAt.$gt.getTime(), cutoff);
});
