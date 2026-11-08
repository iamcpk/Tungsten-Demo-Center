import type { NextFunction, Request, Response } from 'express';
import { isRunningInAzure } from '@tdc/core';

/**
 * Admin: platform owner (everything, including the approver list).
 * Approver: can approve videos for the public site. Granted by the Entra "Approver" app role,
 *   or by an administrator adding the person on the in-app Approvers page.
 * Creator: Solutions Consultants who add and edit videos and submit them for approval.
 * Roles come from Entra ID app roles ("Editor" is the older name for Creator).
 */
export type Role = 'Admin' | 'Approver' | 'Creator';
export interface AdminUser {
  id: string;
  name: string;
  email?: string;
  roles: Role[];
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AdminUser;
  }
}

interface ClientPrincipal {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims?: { typ: string; val: string }[];
}

const ROLE_CLAIMS = new Set(['roles', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role']);
/** Entra app role value -> portal role. An Entra "Approver" role is honoured too, alongside the in-app list. */
const ROLE_MAP: Record<string, Role> = { Admin: 'Admin', Approver: 'Approver', Creator: 'Creator', Editor: 'Creator' };

/**
 * Parse the X-MS-CLIENT-PRINCIPAL header that App Service Authentication (Easy Auth)
 * injects after validating the Entra ID sign-in. Easy Auth strips any copy of this
 * header sent by the client, so it can be trusted only when Easy Auth is enabled.
 */
export function parsePrincipal(header: string | undefined): AdminUser | undefined {
  if (!header) return undefined;
  let p: ClientPrincipal;
  try {
    p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as ClientPrincipal;
  } catch {
    return undefined;
  }
  const claims = p.claims ?? [];
  const get = (...types: string[]) => claims.find((c) => types.includes(c.typ))?.val;
  const roleTyp = p.role_typ;
  const roles = claims
    .filter((c) => ROLE_CLAIMS.has(c.typ) || c.typ === roleTyp)
    .map((c) => ROLE_MAP[c.val])
    .filter((r): r is Role => !!r);
  const id = get('http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid');
  if (!id) return undefined;
  return {
    id,
    name: get('name') ?? get('preferred_username') ?? 'Unknown user',
    email: get('preferred_username', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'),
    roles: [...new Set(roles)],
  };
}

export type AuthMode = 'easyauth' | 'dev';

export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const mode = (env.AUTH_MODE ?? 'easyauth') as AuthMode;
  if (mode === 'dev') {
    if (isRunningInAzure() || env.NODE_ENV === 'production') {
      throw new Error('AUTH_MODE=dev is refused in Azure / production');
    }
    return 'dev';
  }
  if (mode !== 'easyauth') throw new Error(`Unknown AUTH_MODE ${mode}`);
  // Refuse to start in Azure unless platform authentication is switched on.
  if (isRunningInAzure() && String(env.WEBSITE_AUTH_ENABLED).toLowerCase() !== 'true') {
    throw new Error('App Service Authentication must be enabled for the admin app');
  }
  return mode;
}

export function authenticate(mode: AuthMode) {
  return (req: Request, res: Response, next: NextFunction) => {
    req.user = mode === 'dev'
      ? { id: 'dev-user', name: 'Local Developer', email: 'dev@localhost', roles: ['Admin', 'Creator'] }
      : parsePrincipal(req.header('x-ms-client-principal'));
    if (!req.user) return res.status(401).json({ error: 'Sign-in required' });
    next();
  };
}

export interface ApproverSets {
  /** Added on the Approvers page: grants approval rights. */
  portal: Set<string>;
  /** Recorded from the Entra Approver role: email only, never grants rights by itself. */
  entra: Set<string>;
}
export interface ApproverSync {
  /** Someone with the Entra Approver role signed in and isn't on the email list yet. */
  recordEntraApprover(user: AdminUser): Promise<void>;
  /** Someone recorded from Entra no longer holds the role. */
  dropEntraApprover(email: string): Promise<void>;
}

/**
 * Adds the Approver role to signed-in users on the in-app approver list, and keeps the approver email
 * list in step with the Entra "Approver" app role (Entra holders are added when they sign in, and removed
 * when they sign in without the role). Only users who can sign in (they hold an Entra app role) can be approvers.
 */
export function withApprovers(load: () => Promise<ApproverSets>, sync?: ApproverSync) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const u = req.user;
      const email = u?.email?.toLowerCase();
      if (u && email && u.roles.length) {
        const sets = await load();
        const entraRole = u.roles.includes('Approver');
        if (sync) {
          try {
            if (entraRole && !sets.portal.has(email) && !sets.entra.has(email)) await sync.recordEntraApprover(u);
            else if (!entraRole && sets.entra.has(email)) await sync.dropEntraApprover(email);
          } catch (e) {
            // Keeping the email list in step must never block the request.
            console.error('approver list sync failed', (e as Error).message);
          }
        }
        if (!entraRole && sets.portal.has(email)) u.roles = [...u.roles, 'Approver'];
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** Admin always passes. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ok = req.user?.roles.some((r) => r === 'Admin' || roles.includes(r));
    if (!ok) return res.status(403).json({ error: 'You do not have permission for this action' });
    next();
  };
}

/**
 * CSRF defence for cookie-authenticated APIs: state-changing requests must carry a
 * custom header (which a cross-site form cannot set) and, when present, a same-origin Origin.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.header('x-tdc-csrf') !== '1') return res.status(403).json({ error: 'Missing CSRF header' });
  const origin = req.header('origin');
  if (origin) {
    const host = req.header('x-forwarded-host') ?? req.header('host');
    try {
      if (new URL(origin).host !== host) return res.status(403).json({ error: 'Cross-origin request refused' });
    } catch {
      return res.status(403).json({ error: 'Bad origin' });
    }
  }
  next();
}
