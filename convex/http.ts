import Stripe from 'stripe';
import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server.js';
import { processStripeEvent, stripeClient } from './stripeBilling.ts';

const http = httpRouter();
http.route({ path: '/stripe/webhook', method: 'POST', handler: httpAction(async (ctx, request) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('Billing not configured', { status: 503 });
  if (Number(request.headers.get('content-length') ?? 0) > 1048576) return new Response('Too large', { status: 413 });
  const body = await request.text();
  if (body.length > 1048576) return new Response('Too large', { status: 413 });
  let event: Stripe.Event;
  try {
    event = await stripeClient().webhooks.constructEventAsync(body, request.headers.get('stripe-signature') ?? '', secret, 300, Stripe.createSubtleCryptoProvider());
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }
  if (event.livemode !== (process.env.STRIPE_BILLING_MODE === 'live')) return new Response('Wrong environment', { status: 400 });
  try {
    await processStripeEvent(ctx, event);
    return new Response('ok');
  } catch {
    return new Response('Delivery not saved; retry', { status: 503 });
  }
}) });
export default http;
