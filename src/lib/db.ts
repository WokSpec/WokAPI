import type { AuthUser } from '../types';

interface UpsertUserInput {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface OAuthAccountInput {
  userId: string;
  provider: 'github' | 'google' | 'discord';
  providerAccountId: string;
  accessToken?: string;
  refreshToken?: string;
}

interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: string;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function upsertUser(
  db: D1Database,
  input: UpsertUserInput,
): Promise<AuthUser> {
  const existing = input.email
    ? await db
        .prepare('SELECT id, email, username, display_name, avatar_url, role, org FROM users WHERE email = ?')
        .bind(input.email)
        .first() as unknown as AuthUser
        : null;

        if (existing) {
        await db
        .prepare('UPDATE users SET display_name = ?, avatar_url = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(input.displayName, input.avatarUrl, existing.id)
        .run();
        return {
        ...existing,
        display_name: input.displayName,
        avatar_url: input.avatarUrl,
        };
        }

        const created = await db
        .prepare(
        'INSERT INTO users (email, display_name, avatar_url) VALUES (?, ?, ?) RETURNING id, email, username, display_name, avatar_url, role, org',
        )

    .bind(input.email, input.displayName, input.avatarUrl)
    .first() as unknown as AuthUser;

  if (!created) {
    throw new Error('Failed to create user');
  }

  return created;
}

export async function upsertOAuthAccount(
  db: D1Database,
  input: OAuthAccountInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, access_token, refresh_token)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, provider_user_id) DO UPDATE SET
         user_id = excluded.user_id,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token`,
    )
    .bind(input.userId, input.provider, input.providerAccountId, input.accessToken ?? null, input.refreshToken ?? null)
    .run();
}

export async function createSession(
  db: D1Database,
  userId: string,
  refreshHash: string,
  expiresAt: Date,
  _meta?: { userAgent?: string; ipAddress?: string },
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(refreshHash, userId, toIsoString(expiresAt))
    .run();
}

export async function findSessionByRefreshHash(
  db: D1Database,
  refreshHash: string,
): Promise<SessionRecord | null> {
  const row = await db
    .prepare('SELECT id, user_id as userId, expires_at as expiresAt FROM sessions WHERE id = ?')
    .bind(refreshHash)
    .first<SessionRecord>();
  return row ?? null;
}

export async function deleteSessionByRefreshHash(db: D1Database, refreshHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(refreshHash).run();
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

export async function findUserById(db: D1Database, userId: string): Promise<AuthUser | null> {
  const row = await db
    .prepare('SELECT id, email, username, display_name, avatar_url, role, org FROM users WHERE id = ?')
    .bind(userId)
    .first() as unknown as AuthUser;
  return row ?? null;
}

export async function pruneExpiredSessions(db: D1Database): Promise<void> {
  await db
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run();
}
