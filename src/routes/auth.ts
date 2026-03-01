// Auth routes: GitHub / Google / Discord OAuth + JWT session management
// Session cookie: wokspec_session (httpOnly, Secure, SameSite=Lax, 7-day)

import { Hono } from 'hono';
import { signJWT, verifyJWT } from '../lib/jwt';
import type { Env, AuthUser } from '../types';

const auth = new Hono<{ Bindings: Env }>();

const REDIRECT_BASE = 'https://api.wokspec.org/v1/auth';
const POST_LOGIN_REDIRECT = 'https://wokspec.org/account';
const COOKIE_NAME = 'wokspec_session';
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

// ── Helpers ──────────────────────────────────────────────────────────────────

function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function generateState(kv: KVNamespace): Promise<string> {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await kv.put(`oauth_state:${state}`, '1', { expirationTtl: 600 });
  return state;
}

async function consumeState(kv: KVNamespace, state: string): Promise<boolean> {
  const val = await kv.get(`oauth_state:${state}`);
  if (!val) return false;
  await kv.delete(`oauth_state:${state}`);
  return true;
}

async function createSession(env: Env, userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  return signJWT({ sub: userId, exp }, env.JWT_SECRET);
}

/** Upsert user + oauth_account, return user id */
async function upsertUser(
  db: D1Database,
  provider: 'github' | 'google' | 'discord',
  providerUserId: string,
  profile: { email: string | null; username: string | null; displayName: string | null; avatarUrl: string | null },
  accessToken: string,
): Promise<string> {
  // Find existing oauth_account
  const existing = await db
    .prepare('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?')
    .bind(provider, providerUserId)
    .first<{ user_id: string }>();

  if (existing) {
    // Update access token + user profile
    await db
      .prepare('UPDATE oauth_accounts SET access_token = ? WHERE provider = ? AND provider_user_id = ?')
      .bind(accessToken, provider, providerUserId)
      .run();
    await db
      .prepare(
        'UPDATE users SET email = COALESCE(?, email), display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), updated_at = datetime(\'now\') WHERE id = ?',
      )
      .bind(profile.email, profile.displayName, profile.avatarUrl, existing.user_id)
      .run();
    return existing.user_id;
  }

  // Create new user
  const userId = crypto.randomUUID().replace(/-/g, '');
  await db
    .prepare(
      'INSERT INTO users (id, email, username, display_name, avatar_url) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(userId, profile.email, profile.username, profile.displayName, profile.avatarUrl)
    .run();
  await db
    .prepare(
      'INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, access_token) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(crypto.randomUUID().replace(/-/g, ''), userId, provider, providerUserId, accessToken)
    .run();
  return userId;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

auth.get('/github', async (c) => {
  const state = await generateState(c.env.OAUTH_STATE);
  const params = new URLSearchParams({
    client_id: c.env.GITHUB_CLIENT_ID,
    redirect_uri: `${REDIRECT_BASE}/github/callback`,
    scope: 'user:email',
    state,
  });
  return c.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

auth.get('/github/callback', async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
  if (!(await consumeState(c.env.OAUTH_STATE, state))) return c.json({ error: 'Invalid state' }, 400);

  // Exchange code for token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${REDIRECT_BASE}/github/callback`,
    }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) return c.json({ error: 'Token exchange failed' }, 400);

  // Fetch user profile
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'WokAPI/1.0' },
  });
  const ghUser = await userRes.json<{
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
    email: string | null;
  }>();

  // Fetch primary email if not on profile
  let email = ghUser.email;
  if (!email) {
    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'WokAPI/1.0' },
    });
    const emails = await emailRes.json<{ email: string; primary: boolean; verified: boolean }[]>();
    email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
  }

  const userId = await upsertUser(
    c.env.DB,
    'github',
    String(ghUser.id),
    { email, username: ghUser.login, displayName: ghUser.name, avatarUrl: ghUser.avatar_url },
    tokenData.access_token,
  );

  const token = await createSession(c.env, userId);
  return new Response(null, {
    status: 302,
    headers: { Location: POST_LOGIN_REDIRECT, 'Set-Cookie': sessionCookie(token) },
  });
});

// ── Google ───────────────────────────────────────────────────────────────────

auth.get('/google', async (c) => {
  const state = await generateState(c.env.OAUTH_STATE);
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${REDIRECT_BASE}/google/callback`,
    scope: 'openid email profile',
    response_type: 'code',
    state,
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

auth.get('/google/callback', async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
  if (!(await consumeState(c.env.OAUTH_STATE, state))) return c.json({ error: 'Invalid state' }, 400);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${REDIRECT_BASE}/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) return c.json({ error: 'Token exchange failed' }, 400);

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const gUser = await userRes.json<{
    id: string;
    email: string;
    name: string;
    picture: string;
  }>();

  const userId = await upsertUser(
    c.env.DB,
    'google',
    gUser.id,
    { email: gUser.email, username: null, displayName: gUser.name, avatarUrl: gUser.picture },
    tokenData.access_token,
  );

  const token = await createSession(c.env, userId);
  return new Response(null, {
    status: 302,
    headers: { Location: POST_LOGIN_REDIRECT, 'Set-Cookie': sessionCookie(token) },
  });
});

// ── Discord ──────────────────────────────────────────────────────────────────

auth.get('/discord', async (c) => {
  const state = await generateState(c.env.OAUTH_STATE);
  const params = new URLSearchParams({
    client_id: c.env.DISCORD_CLIENT_ID,
    redirect_uri: `${REDIRECT_BASE}/discord/callback`,
    scope: 'identify email',
    response_type: 'code',
    state,
  });
  return c.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

auth.get('/discord/callback', async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
  if (!(await consumeState(c.env.OAUTH_STATE, state))) return c.json({ error: 'Invalid state' }, 400);

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.DISCORD_CLIENT_ID,
      client_secret: c.env.DISCORD_CLIENT_SECRET,
      redirect_uri: `${REDIRECT_BASE}/discord/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenRes.json<{ access_token?: string; error?: string }>();
  if (!tokenData.access_token) return c.json({ error: 'Token exchange failed' }, 400);

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const dUser = await userRes.json<{
    id: string;
    username: string;
    global_name: string | null;
    email: string | null;
    avatar: string | null;
  }>();

  const avatarUrl = dUser.avatar
    ? `https://cdn.discordapp.com/avatars/${dUser.id}/${dUser.avatar}.png`
    : null;

  const userId = await upsertUser(
    c.env.DB,
    'discord',
    dUser.id,
    { email: dUser.email, username: dUser.username, displayName: dUser.global_name, avatarUrl },
    tokenData.access_token,
  );

  const token = await createSession(c.env, userId);
  return new Response(null, {
    status: 302,
    headers: { Location: POST_LOGIN_REDIRECT, 'Set-Cookie': sessionCookie(token) },
  });
});

// ── Session management ───────────────────────────────────────────────────────

auth.post('/logout', (c) => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearCookie() },
  });
});

auth.get('/me', async (c) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const match = cookieHeader.match(/wokspec_session=([^;]+)/);
  const token = match?.[1];
  if (!token) return c.json({ ok: false, error: 'Unauthorized' }, 401);

  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload || typeof payload.sub !== 'string') {
    return c.json({ ok: false, error: 'Invalid session' }, 401);
  }

  const user = await c.env.DB
    .prepare('SELECT id, email, username, display_name, avatar_url FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<AuthUser>();

  if (!user) return c.json({ ok: false, error: 'User not found' }, 401);
  return c.json({ ok: true, user });
});

export { auth as authRouter };
