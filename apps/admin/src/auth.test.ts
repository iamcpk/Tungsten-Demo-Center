import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { parsePrincipal, withApprovers, type AdminUser, type ApproverSync } from './auth.js';

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

test('maps the Entra Approver app role', () => {
  const u = parsePrincipal(enc({ role_typ: 'roles', claims: [{ typ: 'oid', val: 'x' }, { typ: 'roles', val: 'Approver' }] }));
  assert.deepEqual(u?.roles, ['Approver']);
});

/** Runs the withApprovers middleware for one user and reports roles plus sync calls. */
async function runApprovers(user: AdminUser, sets: { portal?: string[]; entra?: string[] }, failSync = false) {
  const calls: string[] = [];
  const sync: ApproverSync = {
    recordEntraApprover: async (u) => { calls.push(`record:${u.email}`); if (failSync) throw new Error('db down'); },
    dropEntraApprover: async (e) => { calls.push(`drop:${e}`); },
  };
  const req = { user: { ...user, roles: [...user.roles] } } as unknown as Request;
  let err: unknown;
  await withApprovers(async () => ({ portal: new Set(sets.portal ?? []), entra: new Set(sets.entra ?? []) }), sync)(req, {} as Response, (e?: unknown) => { err = e; });
  return { roles: req.user!.roles, calls, err };
}
const person = (roles: AdminUser['roles'], email = 'Pat@Example.com'): AdminUser => ({ id: '1', name: 'Pat', email, roles });

test('portal approver list grants Approver to people who can sign in', async () => {
  assert.deepEqual((await runApprovers(person(['Creator']), { portal: ['pat@example.com'] })).roles, ['Creator', 'Approver']);
  // No Entra role at all: can't sign in, so the list grants nothing.
  assert.deepEqual((await runApprovers(person([]), { portal: ['pat@example.com'] })).roles, []);
});

test('Entra Approver role holders are recorded on the email list once', async () => {
  const first = await runApprovers(person(['Approver']), {});
  assert.deepEqual(first.calls, ['record:Pat@Example.com']);
  assert.deepEqual(first.roles, ['Approver']);
  assert.deepEqual((await runApprovers(person(['Approver']), { entra: ['pat@example.com'] })).calls, []);
  assert.deepEqual((await runApprovers(person(['Approver']), { portal: ['pat@example.com'] })).calls, []);
});

test('an Entra entry never grants rights and is dropped when the role goes', async () => {
  const r = await runApprovers(person(['Creator']), { entra: ['pat@example.com'] });
  assert.deepEqual(r.roles, ['Creator']);
  assert.deepEqual(r.calls, ['drop:pat@example.com']);
});

test('a failing list update does not block the request', async () => {
  const r = await runApprovers(person(['Approver']), {}, true);
  assert.equal(r.err, undefined);
  assert.deepEqual(r.roles, ['Approver']);
});

test('rejects garbage and principals without an object id', () => {
  assert.equal(parsePrincipal('not-base64-json'), undefined);
  assert.equal(parsePrincipal(enc({ claims: [{ typ: 'roles', val: 'Admin' }] })), undefined);
  assert.equal(parsePrincipal(undefined), undefined);
});
