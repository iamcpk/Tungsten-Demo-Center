import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdminUser, Role } from './auth.js';
import { decisionBlockedReason, editBlockedReason, statusChangeError } from './workflow.js';

const user = (email: string, ...roles: Role[]): AdminUser => ({ id: email, name: email, email, roles });
const creator = user('creator@example.com', 'Creator');
const approver = user('approver@example.com', 'Creator', 'Approver');
const admin = user('admin@example.com', 'Admin');

test('creators cannot publish directly, only submit', () => {
  assert.equal(statusChangeError(creator, undefined, 'draft'), undefined);
  assert.equal(statusChangeError(creator, 'draft', 'pending'), undefined);
  assert.equal(statusChangeError(creator, 'pending', 'draft'), undefined);
  assert.ok(statusChangeError(creator, 'draft', 'active'));
  assert.ok(statusChangeError(creator, undefined, 'archived'));
});

test('nobody publishes through save; approvers manage published videos', () => {
  assert.ok(statusChangeError(approver, 'pending', 'active'));
  assert.ok(statusChangeError(admin, 'draft', 'active'));
  assert.equal(statusChangeError(approver, 'active', 'archived'), undefined);
  assert.equal(statusChangeError(approver, 'active', 'draft'), undefined);
  assert.ok(statusChangeError(approver, 'active', 'pending'));
  assert.ok(statusChangeError(creator, 'active', 'active'));
});

test('creators cannot edit published videos', () => {
  assert.ok(editBlockedReason(creator, { status: 'active' }));
  assert.ok(editBlockedReason(creator, { status: 'archived' }));
  assert.equal(editBlockedReason(creator, { status: 'pending' }), undefined);
  assert.equal(editBlockedReason(approver, { status: 'active' }), undefined);
});

test('approval: approvers only, pending only, no self-approval except admins', () => {
  const pendingBy = (who: string) => ({ status: 'pending' as const, createdBy: who, review: { submittedBy: who } });
  assert.ok(decisionBlockedReason(creator, pendingBy('someone@example.com')));
  assert.equal(decisionBlockedReason(approver, pendingBy('creator@example.com')), undefined);
  assert.ok(decisionBlockedReason(approver, pendingBy('APPROVER@example.com')));
  assert.equal(decisionBlockedReason(admin, pendingBy('admin@example.com')), undefined);
  assert.ok(decisionBlockedReason(approver, { status: 'draft', createdBy: 'creator@example.com' }));
});
