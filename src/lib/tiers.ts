import type { ApiKeyTier } from '../types';

export interface TierLimits {
  requestsPerMonth: number;  // -1 = unlimited
  requestsPerMinute: number;
  maxApiKeys: number;
  scopes: string[];
}

export const TIER_LIMITS: Record<ApiKeyTier, TierLimits> = {
  free: {
    requestsPerMonth: 1_000,
    requestsPerMinute: 10,
    maxApiKeys: 3,
    scopes: ['read'],
  },
  pro: {
    requestsPerMonth: 100_000,
    requestsPerMinute: 100,
    maxApiKeys: 25,
    scopes: ['read', 'write', 'ai'],
  },
  enterprise: {
    requestsPerMonth: -1,
    requestsPerMinute: 1_000,
    maxApiKeys: -1,
    scopes: ['read', 'write', 'ai', 'admin'],
  },
};

export function getTierLimits(plan: ApiKeyTier): TierLimits {
  return TIER_LIMITS[plan] ?? TIER_LIMITS.free;
}

export function isUnlimited(plan: ApiKeyTier): boolean {
  return TIER_LIMITS[plan].requestsPerMonth === -1;
}
