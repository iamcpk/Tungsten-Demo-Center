/**
 * Two-stage publishing rules. Pure functions so every rule is unit tested.
 *
 *   Content Creator: create / edit unpublished videos, submit them for approval.
 *   Approver:        everything a creator can do, plus approve, request changes, and edit or
 *                    unpublish published videos. Cannot approve a video they submitted themselves.
 *   Admin:           everything, including approving their own submissions and the approver list.
 */
import type { Video, VideoStatus } from '@tdc/core';
import type { AdminUser } from './auth.js';

export const isPublished = (s: VideoStatus) => s === 'active' || s === 'archived';
export const canApprove = (u: AdminUser) => u.roles.includes('Admin') || u.roles.includes('Approver');
export const isAdmin = (u: AdminUser) => u.roles.includes('Admin');

/** The identity recorded on a video: email when Entra provides one, otherwise the object id. */
export const actorId = (u: AdminUser) => (u.email ?? u.id).toLowerCase();

/** Creators may only change videos that are not public. */
export function editBlockedReason(u: AdminUser, v: Pick<Video, 'status'>): string | undefined {
  if (isPublished(v.status) && !canApprove(u)) {
    return 'This video is published. Only an approver or administrator can change it.';
  }
  return undefined;
}

/**
 * Status change through create / save. Publishing never happens here: a video only becomes public
 * through the approve action, which records who approved it.
 */
export function statusChangeError(u: AdminUser, from: VideoStatus | undefined, to: VideoStatus): string | undefined {
  const wasPublic = from !== undefined && isPublished(from);
  if (wasPublic) {
    if (!canApprove(u)) return 'Only an approver or administrator can change a published video.';
    if (to === 'pending') return 'A published video cannot be sent for approval. Unpublish it to Draft first.';
    return undefined; // approvers can switch active <-> archived or unpublish to draft
  }
  if (isPublished(to)) return 'New and draft videos are published through approval. Submit the video for approval instead.';
  return undefined; // draft <-> pending
}

/** Can this user approve (or send back) this video right now? Returns the reason when not. */
export function decisionBlockedReason(u: AdminUser, v: Pick<Video, 'status' | 'review' | 'createdBy'>): string | undefined {
  if (!canApprove(u)) return 'Only approvers and administrators can approve videos.';
  if (v.status !== 'pending') return 'Only videos awaiting approval can be approved or sent back.';
  const submitter = (v.review?.submittedBy ?? v.createdBy ?? '').toLowerCase();
  if (submitter && submitter === actorId(u) && !isAdmin(u)) {
    return 'You submitted this video, so another approver needs to review it.';
  }
  return undefined;
}
