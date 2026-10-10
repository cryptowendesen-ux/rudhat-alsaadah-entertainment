'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMin, fromMin, isRealDate, isFridayDate, withinHours, normalizePhone, dayWindow, overlapCount } = require('../lib/logic');

// same defaults as server.js (Sat-Thu 09:00-21:00, Fri 14:00-22:00, 3 h party)
const ST = { weekdayOpen: '09:00', weekdayClose: '21:00', fridayOpen: '14:00', fridayClose: '22:00', partyMinutes: 180, maxParallel: 1 };
const NIGHT = { ...ST, weekdayOpen: '14:00', weekdayClose: '02:00' }; // closes after midnight
// 2026-10-09 is a Friday, 2026-10-10 a Saturday, 2026-10-11 a Sunday
const FRI = '2026-10-09', SAT = '2026-10-10', SUN = '2026-10-11';

test('toMin / fromMin', () => {
  assert.equal(toMin('00:00'), 0);
  assert.equal(toMin('09:30'), 570);
  assert.equal(toMin('23:59'), 1439);
  assert.equal(toMin('9:05'), 545);
  for (const bad of ['', null, undefined, '24:00', '12:60', 'ab:cd', '12-30', '1230']) assert.ok(Number.isNaN(toMin(bad)), String(bad));
  assert.equal(fromMin(0), '00:00');
  assert.equal(fromMin(570), '09:30');
  assert.equal(fromMin(1439), '23:59');
});

test('fromMin wraps past midnight (used for after-midnight closing and slot grids)', () => {
  assert.equal(fromMin(1440), '00:00');
  assert.equal(fromMin(1560), '02:00');
  assert.equal(fromMin(-30), '23:30');
  assert.equal(fromMin(NaN), '00:00');
});

test('toMin and fromMin are inverse for every minute of the day', () => {
  for (let m = 0; m < 1440; m++) assert.equal(toMin(fromMin(m)), m);
});

test('isRealDate', () => {
  for (const ok of ['2026-10-09', '2028-02-29', '2026-12-31', '2026-01-01']) assert.ok(isRealDate(ok), ok);
  for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '26-10-09', '2026/10/09', '', null, undefined, '2026-1-9', '2026-10-09T10:00'])
    assert.ok(!isRealDate(bad), String(bad));
});

test('isFridayDate', () => {
  assert.ok(isFridayDate(FRI));
  assert.ok(isFridayDate('2026-10-16'));
  assert.ok(!isFridayDate(SAT));
  assert.ok(!isFridayDate(SUN));
  assert.ok(!isFridayDate('2026-02-30'));
  assert.ok(!isFridayDate('nonsense'));
});

test('dayWindow: weekday, Friday and after-midnight closing', () => {
  assert.deepEqual(dayWindow(SAT, ST), { open: 540, close: 1260, wrapped: false });
  assert.deepEqual(dayWindow(FRI, ST), { open: 840, close: 1320, wrapped: false });
  assert.deepEqual(dayWindow(SAT, NIGHT), { open: 840, close: 1560, wrapped: true });
  // identical open/close = open around the clock (24 h window), never an empty window
  assert.deepEqual(dayWindow(SAT, { ...ST, weekdayOpen: '10:00', weekdayClose: '10:00' }), { open: 600, close: 2040, wrapped: true });
});

test('withinHours: normal window (start must be >= open and < close)', () => {
  assert.ok(withinHours('09:00', '09:00', '21:00'));
  assert.ok(withinHours('20:59', '09:00', '21:00'));
  assert.ok(!withinHours('08:59', '09:00', '21:00'));
  assert.ok(!withinHours('21:00', '09:00', '21:00'));
  assert.ok(!withinHours('23:30', '09:00', '21:00'));
});

test('withinHours: window that closes after midnight', () => {
  assert.ok(withinHours('14:00', '14:00', '02:00'));
  assert.ok(withinHours('23:30', '14:00', '02:00'));
  assert.ok(withinHours('00:00', '14:00', '02:00'));
  assert.ok(withinHours('01:59', '14:00', '02:00'));
  assert.ok(!withinHours('02:00', '14:00', '02:00'));
  assert.ok(!withinHours('10:00', '14:00', '02:00'));
});

test('withinHours: garbage in -> false', () => {
  assert.equal(withinHours('xx', '09:00', '21:00'), false);
  assert.equal(withinHours('10:00', '', '21:00'), false);
  assert.equal(withinHours('10:00', '09:00', null), false);
});

test('normalizePhone: UAE formats all become the same number', () => {
  const want = '+971501234567';
  for (const input of ['+971 50 123 4567', '+971501234567', '050 123 4567', '0501234567', '00971501234567', '971501234567', '501234567', '(050) 123-4567', '  +971-50-123-4567  '])
    assert.equal(normalizePhone(input), want, input);
});

test('normalizePhone: other countries keep their code', () => {
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('0044 7700 900123'), '+447700900123');
});

test('normalizePhone: rejects things that are not phone numbers', () => {
  for (const bad of ['', '   ', null, undefined, 'abc', '12345', '+1234567', '050 123 45x7', '<script>', '+971 50 123 4567; DROP', '1234567890123456', '+12345678901234567'])
    assert.equal(normalizePhone(bad), '', String(bad));
});

test('normalizePhone is idempotent', () => {
  for (const input of ['050 123 4567', '+44 7700 900123', '00971501234567']) {
    const once = normalizePhone(input);
    assert.equal(normalizePhone(once), once);
  }
});

test('normalizePhone output always fits the booking schema (max 30 chars)', () => {
  assert.ok(normalizePhone('+' + '9'.repeat(15)).length <= 30);
});

test('overlapCount: 3 h parties on a normal day', () => {
  const ex = [{ time: '10:00' }]; // 10:00 - 13:00
  assert.equal(overlapCount(SAT, '09:00', ST, ex), 1); // 09-12 overlaps
  assert.equal(overlapCount(SAT, '10:00', ST, ex), 1);
  assert.equal(overlapCount(SAT, '12:30', ST, ex), 1);
  assert.equal(overlapCount(SAT, '13:00', ST, ex), 0); // starts exactly when the other ends
  assert.equal(overlapCount(SAT, '07:00', ST, ex), 0); // ends exactly when the other starts
  assert.equal(overlapCount(SAT, '16:00', ST, ex), 0);
});

test('overlapCount: counts every overlapping booking and ignores broken rows', () => {
  const ex = [{ time: '10:00' }, { time: '11:00' }, { time: '19:00' }, { time: 'bad' }, null, {}];
  assert.equal(overlapCount(SAT, '11:30', ST, ex), 2);
  assert.equal(overlapCount(SAT, '18:00', ST, ex), 1);
  assert.equal(overlapCount(SAT, '11:30', ST, []), 0);
  assert.equal(overlapCount(SAT, '11:30', ST, undefined), 0);
  assert.equal(overlapCount(SAT, 'bad', ST, ex), 0);
});

test('overlapCount: respects partyMinutes from the settings', () => {
  const ex = [{ time: '10:00' }];
  const short = { ...ST, partyMinutes: 60 };
  assert.equal(overlapCount(SAT, '11:00', short, ex), 0);
  assert.equal(overlapCount(SAT, '10:59', short, ex), 1);
  assert.equal(overlapCount(SAT, '11:00', { ...ST, partyMinutes: 0 }, ex), 1); // 0 falls back to 180
});

test('overlapCount: after-midnight slots belong to the same opening day', () => {
  // opening day 14:00 -> 02:00; an existing party 23:30 - 02:30 and a new one at 00:30 (next calendar day, same opening day)
  assert.equal(overlapCount(SAT, '00:30', NIGHT, [{ time: '23:30' }]), 1);
  assert.equal(overlapCount(SAT, '14:00', NIGHT, [{ time: '00:30' }]), 0); // 00:30 is 24:30 of that day, far from 14:00
  assert.equal(overlapCount(SAT, '23:00', NIGHT, [{ time: '00:30' }]), 1);
});

test('slot grid like /api/availability: last 3 h start before 21:00 close is 18:00', () => {
  const { open, close } = dayWindow(SAT, ST);
  const starts = [];
  for (let t = open; t + 180 <= close; t += 30) starts.push(fromMin(t));
  assert.equal(starts[0], '09:00');
  assert.equal(starts[starts.length - 1], '18:00');
  assert.equal(starts.length, 19);
});

test('slot grid for a window that closes after midnight', () => {
  const { open, close } = dayWindow(SAT, NIGHT);
  const starts = [];
  for (let t = open; t + 180 <= close; t += 30) starts.push(fromMin(t));
  assert.equal(starts[0], '14:00');
  assert.equal(starts[starts.length - 1], '23:00'); // 23:00 + 3 h = 02:00
  assert.ok(withinHours('23:00', NIGHT.weekdayOpen, NIGHT.weekdayClose));
});
