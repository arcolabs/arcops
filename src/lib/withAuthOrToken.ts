import { verifyCfAccessJwt } from './cf-access';
import { verifyToken, scopeAllows, type Scope } from './api-tokens';
import { db } from './db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function bearerToken(req): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return null;
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim();
}

// Wraps a handler, accepting EITHER a CF Access JWT (browser session) OR an
// `Authorization: Bearer ts_…` token. Token path skips the same-origin check
// (CSRF doesn't apply — bearer tokens aren't ambient credentials).
//
// `requiredScope` defaults to 'read'. Endpoints that mutate state should
// pass 'write' or 'send' explicitly.
export function withAuthOrToken(handler, opts: { requiredScope?: Scope } = {}) {
  const need: Scope = opts.requiredScope ?? 'read';

  return async (req, res) => {
    const bearer = bearerToken(req);

    if (bearer) {
      const token = await verifyToken(bearer);
      if (!token) return res.status(401).json({ error: 'Invalid or revoked token' });
      if (!scopeAllows(token.scope, need)) {
        return res.status(403).json({ error: `Token scope '${token.scope}' insufficient (need '${need}')` });
      }
      req.user = { userId: token.userId, email: token.email, name: null, viaToken: token.id };
      return handler(req, res);
    }

    // Fall through to CF Access path
    if (MUTATING.has(req.method) && !isSameOrigin(req)) {
      return res.status(403).json({ error: 'Cross-origin request blocked' });
    }
    const identity = await verifyCfAccessJwt(req);
    if (!identity?.email) return res.status(401).json({ error: 'Unauthorized' });

    let [user] = await db.select({ id: users.id, email: users.email, name: users.name })
      .from(users).where(eq(users.email, identity.email));
    if (!user) {
      const [inserted] = await db.insert(users).values({ email: identity.email, name: null })
        .returning({ id: users.id, email: users.email, name: users.name });
      user = inserted;
    }
    req.user = { userId: user.id, email: user.email, name: user.name, viaToken: null };
    return handler(req, res);
  };
}
