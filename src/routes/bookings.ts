import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env, AuthUser } from '../types';
import { requireAuth, rateLimit } from '../middleware';
import { CONSULTATION_PRICE_CENTS } from '../lib/constants';
import { sendEmail, bookingConfirmEmail } from '../lib/resend';

const bookings = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

// POST /v1/bookings/checkout — create Stripe checkout session
bookings.post('/checkout', rateLimit('booking'), requireAuth(), async (c) => {
  const user = c.get('user');

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'mode': 'payment',
      'customer_email': user.email,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': 'WokSpec Consultation Slot',
      'line_items[0][price_data][product_data][description]': 'A 30-minute consultation to see if we can help you.',
      'line_items[0][price_data][unit_amount]': String(CONSULTATION_PRICE_CENTS),
      'line_items[0][quantity]': '1',
      'metadata[user_id]': user.id,
      'success_url': 'https://wokspec.org/consult/success?session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': 'https://wokspec.org/consult',
    }),
  });

  const session = await stripeRes.json<{ id?: string; url?: string; error?: { message: string } }>();
  if (!session.url || !session.id) {
    return c.json({ data: null, error: { code: 'STRIPE_ERROR', message: session.error?.message ?? 'Failed to create checkout', status: 500 } }, 500);
  }

  // Record pending booking
  await c.env.D1_MAIN
    .prepare('INSERT INTO consultation_bookings (id, user_id, stripe_session_id) VALUES (?, ?, ?)')
    .bind(crypto.randomUUID(), user.id, session.id)
    .run();

  return c.json({ data: { checkoutUrl: session.url, sessionId: session.id }, error: null });
});

// POST /v1/bookings/webhook — Stripe webhook
bookings.post('/webhook', async (c) => {
  const body = await c.req.text();
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ data: null, error: { code: 'NO_SIGNATURE', message: 'Missing Stripe signature', status: 400 } }, 400);

  // Verify Stripe webhook signature using HMAC-SHA256
  if (c.env.STRIPE_WEBHOOK_SECRET) {
    const sigParts = Object.fromEntries(signature.split(',').map(s => s.split('=')));
    const timestamp = sigParts['t'];
    const v1 = sigParts['v1'];
    if (!timestamp || !v1) {
      return c.json({ data: null, error: { code: 'INVALID_SIGNATURE', message: 'Malformed Stripe signature', status: 400 } }, 400);
    }
    // Reject events older than 5 minutes (replay attack prevention)
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return c.json({ data: null, error: { code: 'EXPIRED_SIGNATURE', message: 'Webhook timestamp too old', status: 400 } }, 400);
    }
    const signedPayload = `${timestamp}.${body}`;
    const keyData = new TextEncoder().encode(c.env.STRIPE_WEBHOOK_SECRET);
    const msgData = new TextEncoder().encode(signedPayload);
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, msgData);
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (computed !== v1) {
      return c.json({ data: null, error: { code: 'INVALID_SIGNATURE', message: 'Stripe signature mismatch', status: 400 } }, 400);
    }
  }

  let event: { type: string; data: { object: { id: string; payment_intent?: string; metadata?: { user_id?: string } } } };
  try { event = JSON.parse(body); } catch {
    return c.json({ data: null, error: { code: 'INVALID_BODY', message: 'Invalid JSON', status: 400 } }, 400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await c.env.D1_MAIN
      .prepare('UPDATE consultation_bookings SET status = ?, stripe_payment_intent = ? WHERE stripe_session_id = ?')
      .bind('paid', session.payment_intent ?? null, session.id)
      .run();

    // Send confirmation email via Resend
    const customerEmail = (event.data.object as { customer_email?: string }).customer_email;
    if (c.env.RESEND_API_KEY && customerEmail) {
      sendEmail(c.env.RESEND_API_KEY, {
        to: customerEmail,
        subject: 'Booking confirmed — WokSpec consultation ✦',
        html: bookingConfirmEmail(customerEmail),
      }).catch(() => { /* non-fatal */ });
    }
  }

  return c.json({ data: { received: true }, error: null });
});

// GET /v1/bookings — list user's bookings
bookings.get('/', requireAuth(), async (c) => {
  const user = c.get('user');
  const result = await c.env.D1_MAIN
    .prepare('SELECT id, stripe_session_id, status, scheduled_at, created_at FROM consultation_bookings WHERE user_id = ? ORDER BY created_at DESC')
    .bind(user.id)
    .all();
  return c.json({ data: result.results, error: null });
});

export { bookings as bookingsRouter };
