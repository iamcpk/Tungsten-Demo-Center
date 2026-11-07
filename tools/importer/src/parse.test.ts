import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelDate, isHttpUrl, legacyPublishDate, parseMulti, stableId } from './parse.js';

test('parseMulti untangles the cumulative iVengi format', () => {
  const raw = 'Healthcare,Healthcare";"Financial Services,Healthcare";"Financial Services";"Manufacturing';
  assert.deepEqual(parseMulti(raw), ['Healthcare', 'Financial Services', 'Manufacturing']);
  assert.deepEqual(parseMulti('AutoStore,AutoStore";"Business Connect (Mobile)'), ['AutoStore', 'Business Connect (Mobile)']);
  assert.deepEqual(parseMulti('PA,PA";"IA'), ['PA', 'IA']);
  assert.deepEqual(parseMulti('0'), []);
  assert.deepEqual(parseMulti(''), []);
});

test('excelDate converts serial + time', () => {
  assert.equal(excelDate('42912', '16:47'), '2017-06-26T16:47:00.000Z');
  assert.equal(excelDate('', ''), undefined);
});

test('legacyPublishDate reads normal and column-shifted iVengi rows', () => {
  assert.equal(legacyPublishDate(42912, '16:47', ''), '2017-06-26T16:47:00.000Z');
  // Shifted row seen in the Nov 7, 2026 export: date in Date:_time (dd-mm-yyyy), time fraction in the custom column.
  assert.equal(legacyPublishDate('', '04-12-2017', '0.8979166666666667'), '2017-12-04T21:33:00.000Z');
  assert.equal(legacyPublishDate(null, '04-12-2017', ''), '2017-12-04T00:00:00.000Z');
  // A bare time fraction is not a date (it used to come out as Dec 30, 1899).
  assert.equal(legacyPublishDate(0.8979166666666667, '', ''), undefined);
  assert.equal(legacyPublishDate('', '', '0.8979166666666667'), undefined);
});

test('stableId is deterministic and uuid shaped', () => {
  assert.equal(stableId('1603102'), stableId('1603102'));
  assert.match(stableId('1603102'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('isHttpUrl rejects shifted text cells', () => {
  assert.ok(isHttpUrl('https://www.tungstendemocenter.com/IManager/Download/1/a b.pptx'));
  assert.ok(!isHttpUrl(' an email address, folder and printer in a single workflow.'));
});
