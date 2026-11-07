import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excelDate, isHttpUrl, parseMulti, stableId } from './parse.js';

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

test('stableId is deterministic and uuid shaped', () => {
  assert.equal(stableId('1603102'), stableId('1603102'));
  assert.match(stableId('1603102'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('isHttpUrl rejects shifted text cells', () => {
  assert.ok(isHttpUrl('https://www.tungstendemocenter.com/IManager/Download/1/a b.pptx'));
  assert.ok(!isHttpUrl(' an email address, folder and printer in a single workflow.'));
});
