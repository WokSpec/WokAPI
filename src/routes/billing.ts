import { Hono } from 'hono';
import type { Env, AuthUser } from '../types';
import { requireAuth, rateLimit } from '../middleware';
import { CONSULTATION_PRICE_CENTS } from '../lib/constants';
import { sendEmail, bookingConfirmEmail } from '../lib/resend';

const billing = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// ── Checkout ─────────────────────────────────────────────────────────────────

billing.post('/checkout', rateLimit('billing'), requireAuth(), async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ price_id?: string; type?: 'subscription' | 'one-time' | 'consultation' }>().catch(() => ({ price_id: undefined, type: undefined }));
  
  const type = body.type || 'consultation';
  let line_items: any[] = [];
  let metadata: any = { user_id: user.id, type };

  if (type === 'consultation') {
    line_items = [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: 'WokSpec Consultation Slot',
          description: 'A 30-minute consultation with the team.',
        },
        unit_amount: CONSULTATION_PRICE_CENTS,
      },
      quantity: 1,
    }];
  } else if (body.price_id) {
    line_items = [{ price: body.price_id, quantity: 1 }];
  } else {
    return c.json({ data: null, error: { code: 'INVALID_REQUEST', message: 'Missing price_id or valid type', status: 400 } }, 400);
  }

  const mode = body.type === 'subscription' ? 'subscription' : 'payment';

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'mode': mode,
      'customer_email': user.email ?? '',
      'success_url': `https://wokspec.org/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `https://wokspec.org/billing`,
      ...flattenStripeParams({ line_items, metadata }),
    }),
  });

  const session = await stripeRes.json<{ id?: string; url?: string; error?: { message: string } }>();
  if (!session.url || !session.id) {
    return c.json({ data: null, error: { code: 'STRIPE_ERROR', message: session.error?.message ?? 'Failed to create checkout', status: 500 } }, 500);
  }

  // Record pending consultation booking specifically if type is consultation
  if (type === 'consultation') {
    await c.env.D1_MAIN
      .prepare('INSERT INTO consultation_bookings (id, user_id, stripe_session_id) VALUES (?, ?, ?)')
      .bind(crypto.randomUUID(), user.id, session.id)
      .run();
  }

  return c.json({ data: { checkoutUrl: session.url, sessionId: session.id }, error: null });
});

// ── Subscription Plan Checkout ────────────────────────────────────────────────

billing.post('/subscribe', rateLimit('billing'), requireAuth(), async (c) => {
  const user = c.get('user');
  const body = await c.req.json<{ plan?: 'pro' | 'enterprise' }>().catch(() => ({ plan: 'pro' as const }));

  const plan = body.plan === 'enterprise' ? 'enterprise' : 'pro';
  const priceId = plan === 'pro'
    ? c.env.STRIPE_PRICE_PRO_MONTHLY
    : c.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;

  if (!priceId) {
    return c.json({ data: null, error: { code: 'CONFIG_ERROR', message: `${plan} plan not yet available`, status: 503 } }, 503);
  }

  // Reuse or create Stripe customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customerRes = await fetch('https://api.stripe.com/v1/customers', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: user.email ?? '', 'metadata[user_id]': user.id }),
    });
    const customer = await customerRes.json<{ id: string }>();
    customerId = customer.id;
    await c.env.DB.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(customerId, user.id).run();
  }

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'mode': 'subscription',
      'customer': customerId,
      'success_url': `https://dashboard.wokspec.org/tokens?upgraded=1`,
      'cancel_url': `https://dashboard.wokspec.org/tokens`,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user.id,
      'metadata[plan]': plan,
    }),
  });

  const session = await stripeRes.json<{ id?: string; url?: string; error?: { message: string } }>();
  if (!session.url) {
    return c.json({ data: null, error: { code: 'STRIPE_ERROR', message: session.error?.message ?? 'Failed to create checkout', status: 500 } }, 500);
  }

  return c.json({ data: { checkoutUrl: session.url, sessionId: session.id }, error: null });
});


billing.post('/portal', rateLimit('billing'), requireAuth(), async (c) => {
  const user = c.get('user');

  // Find customer ID if we have it, or search Stripe by email
  const listRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(user.email ?? '')}&limit=1`, {
    headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}` },
  });
  const list = await listRes.json<{ data: { id: string }[] }>();
  
  if (list.data.length === 0) {
    return c.json({ data: null, error: { code: 'NO_CUSTOMER', message: 'No active subscription or customer record found.', status: 404 } }, 404);
  }

  const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'customer': list.data[0].id,
      'return_url': 'https://wokspec.org/billing',
    }),
  });

  const session = await portalRes.json<{ url?: string; error?: { message: string } }>();
  if (!session.url) {
    return c.json({ data: null, error: { code: 'STRIPE_ERROR', message: session.error?.message ?? 'Failed to create portal', status: 500 } }, 500);
  }

  return c.json({ data: { portalUrl: session.url }, error: null });
});

// ── Webhook ──────────────────────────────────────────────────────────────────

billing.post('/webhook', async (c) => {
  const body = await c.req.text();
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ data: null, error: { code: 'NO_SIGNATURE', message: 'Missing Stripe signature', status: 400 } }, 400);

  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    return c.json({ data: null, error: { code: 'CONFIG_ERROR', message: 'Missing webhook secret', status: 500 } }, 500);
  }
  
  // Signature verification logic preserved from bookings.ts
  const sigParts = Object.fromEntries(signature.split(',').map(s => s.split('=')));
  const timestamp = sigParts['t'];
  const v1 = sigParts['v1'];
  if (!timestamp || !v1) return c.json({ data: null, error: { code: 'INVALID_SIGNATURE', message: 'Malformed Stripe signature', status: 400 } }, 400);
  
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return c.json({ data: null, error: { code: 'EXPIRED_SIGNATURE', message: 'Webhook timestamp too old', status: 400 } }, 400);
  }
  
  const signedPayload = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(c.env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  if (computed !== v1) {
    return c.json({ data: null, error: { code: 'INVALID_SIGNATURE', message: 'Stripe signature mismatch', status: 400 } }, 400);
  }

  const event = JSON.parse(body);

  // ── Subscription lifecycle events — sync plan to D1 ──────────────────────
  if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const userId = sub.metadata?.user_id;
    if (userId) {
      const plan = sub.metadata?.plan ?? 'pro';
      const status = sub.status;
      const periodEnd = new Date(sub.current_period_end * 1000).toISOString();

      // Upsert subscription record
      await c.env.DB.prepare(`
        INSERT INTO subscriptions (id, user_id, status, plan, current_period_end, cancel_at_period_end, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status, plan = excluded.plan,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          updated_at = excluded.updated_at
      `).bind(sub.id, userId, status, plan, periodEnd, sub.cancel_at_period_end ? 1 : 0).run();

      // Update user plan
      const isActive = status === 'active' || status === 'trialing';
      await c.env.DB.prepare("UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?")
        .bind(isActive ? plan : 'free', isActive ? periodEnd : null, userId)
        .run();
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const userId = sub.metadata?.user_id;
    if (userId) {
      await c.env.DB.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = datetime('now') WHERE id = ?").bind(sub.id).run();
      await c.env.DB.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?").bind(userId).run();
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};

    // Link stripe_customer_id to user on first checkout
    if (session.customer && metadata.user_id) {
      await c.env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL")
        .bind(session.customer, metadata.user_id).run();
    }

    if (metadata.type === 'consultation') {
      await c.env.D1_MAIN
        .prepare('UPDATE consultation_bookings SET status = ?, stripe_payment_intent = ? WHERE stripe_session_id = ?')
        .bind('paid', session.payment_intent ?? null, session.id)
        .run();

      const customerEmail = session.customer_email || session.customer_details?.email;
      if (c.env.RESEND_API_KEY && customerEmail) {
        sendEmail(c.env.RESEND_API_KEY, {
          to: customerEmail,
          subject: 'Booking confirmed — WokSpec consultation ✦',
          html: bookingConfirmEmail(customerEmail),
        }).catch(() => {});
      }
    }
  }

  return c.json({ data: { received: true }, error: null });
});

// ── Subscription Status ──────────────────────────────────────────────────────

billing.get('/subscription', requireAuth(), async (c) => {
  const user = c.get('user');
  
  // Find customer
  const listRes = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(user.email ?? '')}&limit=1&expand[]=data.subscriptions`, {
    headers: { 'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}` },
  });
  const list = await listRes.json<{ data: any[] }>();
  
  if (list.data.length === 0) {
    return c.json({ data: { active: false, subscriptions: [] }, error: null });
  }

  const customer = list.data[0];
  const subscriptions = customer.subscriptions?.data || [];
  
  const activeSubs = subscriptions.filter((s: any) => s.status === 'active' || s.status === 'trialing');

  return c.json({
    data: {
      active: activeSubs.length > 0,
      subscriptions: subscriptions.map((s: any) => ({
        id: s.id,
        status: s.status,
        plan: s.items.data[0]?.plan.product,
        current_period_end: s.current_period_end,
        cancel_at_period_end: s.cancel_at_period_end,
      })),
    },
    error: null,
  });
});

// Helper for Stripe's weird URL-encoded nesting
function flattenStripeParams(params: any, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, flattenStripeParams(val, fullKey));
    } else if (Array.isArray(val)) {
      val.forEach((item, i) => {
        Object.assign(result, flattenStripeParams(item, `${fullKey}[${i}]`));
      });
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}

export { billing as billingRouter };
