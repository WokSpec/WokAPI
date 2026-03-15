import { Hono } from 'hono';
import type { Env } from '../types';
import { signAccessToken, generateRefreshToken, hashToken, verifyJWT } from '../lib/jwt';
import {
  upsertUser, upsertOAuthAccount,
  createSession, findSessionByRefreshHash, deleteSessionByRefreshHash,
  deleteSession, findUserById, pruneExpiredSessions,
} from '../lib/db';
import { rateLimit } from '../middleware';
import { AUTH_COOKIE_NAME, AUTH_REFRESH_COOKIE_NAME, ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL } from '../lib/constants';

const SITE_URL = 'https://wokspec.org';

// Allowed redirect destinations after OAuth
const ALLOWED_REDIRECT_ORIGINS = [
  'https://wokspec.org',
  'https://www.wokspec.org',
  'https://studio.wokspec.org',
  'https://hei.wokspec.org',
  'https://chopsticks.wokspec.org',
  'https://eral.wokspec.org',
  'https://studio.wokspec.org',
  'https://dilu.wokspec.org',
  'https://studio.wokspec.org',
];

function sanitizeRedirectTo(redirectTo: string | null | undefined): string {
  if (!redirectTo) return SITE_URL;
  try {
    const url = new URL(redirectTo);
    if (ALLOWED_REDIRECT_ORIGINS.some((o) => redirectTo.startsWith(o))) return redirectTo;
  } catch { /* invalid URL */ }
  return SITE_URL;
}

const auth = new Hono<{ Bindings: Env }>();

// ===== GITHUB OAUTH =====
auth.get('/github', rateLimit('auth'), async (c) => {
  const redirectTo = sanitizeRedirectTo(c.req.query('redirect_to'));
  const redirectExtension = c.req.query('redirect_extension') === 'true';
  const state = btoa(JSON.stringify({ redirectTo, redirectExtension, nonce: crypto.randomUUID() }));
  await c.env.OAUTH_STATE.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `https://api.wokspec.org/v1/auth/github/callback`);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

auth.get('/github/callback', rateLimit('auth'), async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ data: null, error: { code: 'INVALID_CALLBACK', message: 'Missing code or state', status: 400 } }, 400);

  const stateValid = await c.env.OAUTH_STATE.get(`oauth_state:${state}`);
  if (!stateValid) return c.json({ data: null, error: { code: 'INVALID_STATE', message: 'Invalid OAuth state', status: 400 } }, 400);
  await c.env.OAUTH_STATE.delete(`oauth_state:${state}`);

  let parsedState: { redirectTo: string; redirectExtension?: boolean };
  try { parsedState = JSON.parse(atob(state)); } catch { parsedState = { redirectTo: SITE_URL }; }

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ client_id: c.env.GITHUB_CLIENT_ID, client_secret: c.env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) return c.json({ data: null, error: { code: 'OAUTH_ERROR', message: 'OAuth token exchange failed', status: 400 } }, 400);

  // Get user info
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'WokSpec/1.0' },
  });
  const githubUser = await userRes.json<{ id: number; email: string | null; name: string; avatar_url: string; login: string }>();

  // Get primary email if not public
  let email = githubUser.email;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'WokSpec/1.0' },
    });
    const emails = await emailsRes.json<{ email: string; primary: boolean; verified: boolean }[]>();
    email = emails.find(e => e.primary && e.verified)?.email ?? null;
  }
  if (!email) return c.json({ data: null, error: { code: 'NO_EMAIL', message: 'No verified email found', status: 400 } }, 400);

  const user = await upsertUser(c.env.DB, { email, displayName: githubUser.name ?? githubUser.login, avatarUrl: githubUser.avatar_url });
  await upsertOAuthAccount(c.env.DB, { userId: user.id, provider: 'github', providerAccountId: String(githubUser.id), accessToken: tokenData.access_token });

  return issueTokensAndRedirect(c, user, sanitizeRedirectTo(parsedState.redirectTo), parsedState.redirectExtension);
});

// ===== GOOGLE OAUTH =====
auth.get('/google', rateLimit('auth'), async (c) => {
  const redirectTo = sanitizeRedirectTo(c.req.query('redirect_to'));
  const redirectExtension = c.req.query('redirect_extension') === 'true';
  const state = btoa(JSON.stringify({ redirectTo, redirectExtension, nonce: crypto.randomUUID() }));
  await c.env.OAUTH_STATE.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', c.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', 'https://api.wokspec.org/v1/auth/google/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  return c.redirect(url.toString());
});

auth.get('/google/callback', rateLimit('auth'), async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ data: null, error: { code: 'INVALID_CALLBACK', message: 'Missing code or state', status: 400 } }, 400);

  const stateValid = await c.env.OAUTH_STATE.get(`oauth_state:${state}`);
  if (!stateValid) return c.json({ data: null, error: { code: 'INVALID_STATE', message: 'Invalid OAuth state', status: 400 } }, 400);
  await c.env.OAUTH_STATE.delete(`oauth_state:${state}`);

  let parsedState: { redirectTo: string; redirectExtension?: boolean };
  try { parsedState = JSON.parse(atob(state)); } catch { parsedState = { redirectTo: SITE_URL }; }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: 'https://api.wokspec.org/v1/auth/google/callback', grant_type: 'authorization_code' }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; id_token?: string }>();
  if (!tokenData.access_token) return c.json({ data: null, error: { code: 'OAUTH_ERROR', message: 'Token exchange failed', status: 400 } }, 400);

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const googleUser = await userRes.json<{ id: string; email: string; name: string; picture: string }>();

  const user = await upsertUser(c.env.DB, { email: googleUser.email, displayName: googleUser.name, avatarUrl: googleUser.picture });
  await upsertOAuthAccount(c.env.DB, { userId: user.id, provider: 'google', providerAccountId: googleUser.id, accessToken: tokenData.access_token });

  return issueTokensAndRedirect(c, user, sanitizeRedirectTo(parsedState.redirectTo), parsedState.redirectExtension);
});

// ===== DISCORD OAUTH =====
auth.get('/discord', rateLimit('auth'), async (c) => {
  const redirectTo = sanitizeRedirectTo(c.req.query('redirect_to'));
  const redirectExtension = c.req.query('redirect_extension') === 'true';
  const state = btoa(JSON.stringify({ redirectTo, redirectExtension, nonce: crypto.randomUUID() }));
  await c.env.OAUTH_STATE.put(`oauth_state:${state}`, '1', { expirationTtl: 300 });

  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.searchParams.set('client_id', c.env.DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', 'https://api.wokspec.org/v1/auth/discord/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify email');
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

auth.get('/discord/callback', rateLimit('auth'), async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ data: null, error: { code: 'INVALID_CALLBACK', message: 'Missing code or state', status: 400 } }, 400);

  const stateValid = await c.env.OAUTH_STATE.get(`oauth_state:${state}`);
  if (!stateValid) return c.json({ data: null, error: { code: 'INVALID_STATE', message: 'Invalid OAuth state', status: 400 } }, 400);
  await c.env.OAUTH_STATE.delete(`oauth_state:${state}`);

  let parsedState: { redirectTo: string; redirectExtension?: boolean };
  try { parsedState = JSON.parse(atob(state)); } catch { parsedState = { redirectTo: SITE_URL }; }

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.env.DISCORD_CLIENT_ID, client_secret: c.env.DISCORD_CLIENT_SECRET, redirect_uri: 'https://api.wokspec.org/v1/auth/discord/callback', grant_type: 'authorization_code' }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string }>();
  if (!tokenData.access_token) return c.json({ data: null, error: { code: 'OAUTH_ERROR', message: 'Token exchange failed', status: 400 } }, 400);

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const discordUser = await userRes.json<{ id: string; email?: string; username: string; global_name?: string; avatar?: string }>();

  if (!discordUser.email) return c.json({ data: null, error: { code: 'NO_EMAIL', message: 'Discord account has no verified email', status: 400 } }, 400);
  const avatarUrl = discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png` : null;

  const user = await upsertUser(c.env.DB, { email: discordUser.email, displayName: discordUser.global_name ?? discordUser.username, avatarUrl });
  await upsertOAuthAccount(c.env.DB, { userId: user.id, provider: 'discord', providerAccountId: discordUser.id, accessToken: tokenData.access_token });

  return issueTokensAndRedirect(c, user, sanitizeRedirectTo(parsedState.redirectTo), parsedState.redirectExtension);
});

auth.get('/me', rateLimit('auth'), async (c) => {
  const token = getCookieValue(c.req.header('Cookie'), AUTH_COOKIE_NAME);
  if (!token) {
    return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Not authenticated', status: 401 } }, 401);
  }

  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload || typeof payload.sub !== 'string') {
    return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'Invalid session', status: 401 } }, 401);
  }

  const user = await c.env.DB
    .prepare('SELECT id, email, username, display_name, avatar_url, role, org FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<AuthUser>();

  if (!user) {
    return c.json({ data: null, error: { code: 'UNAUTHORIZED', message: 'User not found', status: 401 } }, 401);
  }

  return c.json({ data: { user }, error: null });
});

// ===== REFRESH TOKEN =====
auth.post('/refresh', rateLimit('auth'), async (c) => {
  // Accept token from cookie OR request body (extension uses body)
  let refreshToken = getCookieValue(c.req.header('Cookie'), AUTH_REFRESH_COOKIE_NAME);
  if (!refreshToken) {
    try {
      const body = await c.req.json<{ refreshToken?: string }>();
      refreshToken = body.refreshToken ?? null;
    } catch { /* no body */ }
  }
  if (!refreshToken) return c.json({ data: null, error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token', status: 401 } }, 401);

  const hash = await hashToken(refreshToken);
  const session = await findSessionByRefreshHash(c.env.DB, hash);
  if (!session || new Date(session.expiresAt) < new Date()) {
    return c.json({ data: null, error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid or expired refresh token', status: 401 } }, 401);
  }

  const user = await findUserById(c.env.DB, session.userId);
  if (!user) return c.json({ data: null, error: { code: 'USER_NOT_FOUND', message: 'User not found', status: 401 } }, 401);

  // Rotate refresh token
  await deleteSession(c.env.DB, session.id);
  // Opportunistically prune stale sessions (fire-and-forget)
  pruneExpiredSessions(c.env.DB).catch(() => {});
  return issueTokensAndRedirect(c, user, null);
});

// ===== LOGOUT =====
auth.post('/logout', async (c) => {
  // Accept refresh token from cookie (web) or request body (extension)
  let refreshToken = getCookieValue(c.req.header('Cookie'), AUTH_REFRESH_COOKIE_NAME);
  if (!refreshToken) {
    try {
      const body = await c.req.json<{ refreshToken?: string }>();
      refreshToken = body.refreshToken ?? null;
    } catch { /* no body */ }
  }
  if (refreshToken) {
    const hash = await hashToken(refreshToken);
    await deleteSessionByRefreshHash(c.env.DB, hash).catch(() => {});
  }
  // Clear cookies
  c.header('Set-Cookie', `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
  c.res.headers.append('Set-Cookie', `${AUTH_REFRESH_COOKIE_NAME}=; Max-Age=0; Path=/v1/auth; HttpOnly; Secure; SameSite=Lax`);
  return c.json({ data: { ok: true }, error: null });
});

// ===== HELPERS =====
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function issueTokensAndRedirect(c: any, user: any, redirectTo: string | null, redirectExtension = false): Promise<Response> {
  const accessToken = await signAccessToken(user, c.env.JWT_SECRET);
  const refreshToken = generateRefreshToken();
  const refreshHash = await hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000);
  await createSession(c.env.DB, user.id, refreshHash, expiresAt, {
    userAgent: c.req.header('user-agent') ?? undefined,
    ipAddress: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined,
  });

  const isProd = c.env.ENVIRONMENT === 'production';

  // Extension flow: redirect to site callback page with tokens in URL params.
  // The wokspec.org/auth/callback page should be a minimal page that posts a
  // message to the extension and then closes itself. Tokens travel over HTTPS
  // Extension/cross-origin flow: redirect with tokens in URL params.
  if (redirectExtension) {
    // If redirect_to points to a non-main-site origin (e.g. eral.wokspec.org), use it directly.
    const callbackBase = redirectTo && !redirectTo.startsWith(SITE_URL)
      ? redirectTo
      : `${SITE_URL}/auth/callback`;
    const callbackUrl = new URL(callbackBase);
    callbackUrl.searchParams.set('accessToken', accessToken);
    callbackUrl.searchParams.set('refreshToken', refreshToken);
    return c.redirect(callbackUrl.toString());
  }

  const cookieOpts = `HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax; Path=/`;

  if (redirectTo) {
    c.header('Set-Cookie', `${AUTH_COOKIE_NAME}=${accessToken}; Max-Age=${ACCESS_TOKEN_TTL}; ${cookieOpts}`);
    c.res.headers.append('Set-Cookie', `${AUTH_REFRESH_COOKIE_NAME}=${refreshToken}; Max-Age=${REFRESH_TOKEN_TTL}; Path=/v1/auth; HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax`);
    return c.redirect(redirectTo);
  }

  // JSON response (used by /refresh)
  c.header('Set-Cookie', `${AUTH_COOKIE_NAME}=${accessToken}; Max-Age=${ACCESS_TOKEN_TTL}; ${cookieOpts}`);
  c.res.headers.append('Set-Cookie', `${AUTH_REFRESH_COOKIE_NAME}=${refreshToken}; Max-Age=${REFRESH_TOKEN_TTL}; Path=/v1/auth; HttpOnly; ${isProd ? 'Secure; ' : ''}SameSite=Lax`);
  return c.json({ data: { user, accessToken, refreshToken }, error: null });
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export { auth as authRouter };
