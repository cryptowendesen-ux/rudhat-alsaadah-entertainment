'use strict';
/* =========================================================
   Pure booking helpers (no database, no network, no clock).
   Used by server.js and unit-tested in test/logic.test.js (npm test).

   Times are "HH:MM" (24 h) strings, dates are "YYYY-MM-DD".
   Opening windows may close after midnight (e.g. 14:00 -> 02:00):
   such a window is "wrapped" and its close is expressed as minutes
   after the opening day's midnight (close > 1440).
========================================================= */

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// "HH:MM" -> minutes since midnight (NaN when the text is not a valid time)
function toMin(t) {
  const m = TIME_RE.exec(String(t == null ? '' : t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

// minutes -> "HH:MM". Values past midnight wrap around (1560 -> "02:00").
function fromMin(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '00:00';
  const m = ((Math.round(v) % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

// true only for a calendar date that exists (rejects 2026-02-30, 2026-13-01, ...)
function isRealDate(s) {
  const m = DATE_RE.exec(String(s == null ? '' : s));
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Friday uses its own opening hours (the date is the OPENING day, also for after-midnight slots)
function isFridayDate(s) {
  return isRealDate(s) && new Date(s + 'T00:00:00Z').getUTCDay() === 5;
}

// Opening window of a date: { open, close, wrapped } in minutes. close > 1440 when it closes after midnight.
function dayWindow(date, st) {
  const fri = isFridayDate(date);
  const open = toMin(fri ? st.fridayOpen : st.weekdayOpen);
  let close = toMin(fri ? st.fridayClose : st.weekdayClose);
  let wrapped = false;
  if (close <= open) { close += 1440; wrapped = true; }
  return { open, close, wrapped };
}

// Is a START time inside the opening window? (the party length is checked separately)
function withinHours(time, open, close) {
  const t = toMin(time), o = toMin(open), c = toMin(close);
  if ([t, o, c].some(Number.isNaN)) return false;
  if (c > o) return t >= o && t < c;
  return t >= o || t < c; // closes after midnight
}

// Phone number -> "+<country code><number>" (digits only after the +), or '' when it cannot be a phone number.
// UAE habits are understood: 050 123 4567, 50 123 4567 (9 digits starting with 5), 00971..., +971...
function normalizePhone(p) {
  const s = String(p == null ? '' : p).trim();
  if (!s || !/^\+?[\d\s()-]+$/.test(s)) return '';
  const plus = s.startsWith('+');
  let d = s.replace(/\D/g, '');
  if (!plus) {
    if (d.startsWith('00')) d = d.slice(2);                    // 00971... -> 971...
    else if (d.startsWith('0')) d = '971' + d.slice(1);       // 050... -> 97150...
    else if (d.length === 9 && d.startsWith('5')) d = '971' + d; // 501234567 -> 971501234567
  }
  if (d.length < 8 || d.length > 15) return '';
  return '+' + d;
}

// How many of the existing bookings (objects with a .time) overlap a new party that starts at `time`?
function overlapCount(date, time, st, existing) {
  const { open, wrapped } = dayWindow(date, st);
  const dur = Number(st.partyMinutes) || 180;
  const norm = (t) => {
    let m = toMin(t);
    if (wrapped && m < open) m += 1440; // after-midnight part belongs to the same opening day
    return m;
  };
  const s = norm(time);
  if (Number.isNaN(s)) return 0;
  const e = s + dur;
  let n = 0;
  for (const b of existing || []) {
    const bs = norm(b && b.time);
    if (Number.isNaN(bs)) continue;
    if (s < bs + dur && bs < e) n++;
  }
  return n;
}

module.exports = { toMin, fromMin, isRealDate, isFridayDate, withinHours, normalizePhone, dayWindow, overlapCount };
