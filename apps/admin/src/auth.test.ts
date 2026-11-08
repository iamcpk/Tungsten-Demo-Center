import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrincipal } from './auth.js';

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

test('parses Easy Auth principal with roles', () => {
  const u = parsePrincipal(enc({
    auth_typ: 'aad', role_typ: 'roles',
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: 'abc' },
      { typ: 'name', val: 'Test User' },
      { typ: 'preferred_username', val: 'test@example.com' },
      { typ: 'roles', val: 'Editor' },
      { typ: 'roles', val: 'NotARole' },
    ],
  }));
  assert.equal(u?.id, 'abc');
  // The older "Editor" app role maps to Content Creator.
  assert.deepEqual(u?.roles, ['Creator']);
  assert.equal(u?.email, 'test@example.com');
});

test('maps Admin, Creator and Editor app roles without duplicates', () => {
  const u = parsePrincipal(enc({
    role_typ: 'roles',
    claims: [
      { typ: 'oid', val: 'x' },
      { typ: 'roles', val: 'Admin' },
      { typ: 'roles', val: 'Creator' },
      { typ: 'roles', val: 'Editor' },
    ],
  }));
  assert.deepEqual(u?.roles, ['Admin', 'Creator']);
});

test('rejects garbage and principals without an object id', () => {
  assert.equal(parsePrincipal('not-base64-json'), undefined);
  assert.equal(parsePrincipal(enc({ claims: [{ typ: 'roles', val: 'Admin' }] })), undefined);
  assert.equal(parsePrincipal(undefined), undefined);
});
