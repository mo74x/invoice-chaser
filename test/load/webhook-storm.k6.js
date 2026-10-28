import http from 'k6/http';
import crypto from 'k6/crypto';
import { check } from 'k6';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = __ENV.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret';
const TOTAL_INVOICES = Number(__ENV.TOTAL_INVOICES || 10000);

export const options = {
  scenarios: {
    // 1. Burst ingestion of finalized invoices (default 10,000)
    burst_ingestion: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: TOTAL_INVOICES,
      maxDuration: '5m',
      exec: 'ingestFinalizedInvoice',
    },
    // 2. Concurrent replay storm (sends same event IDs 10x concurrently)
    idempotency_replay_storm: {
      executor: 'per-vu-iterations',
      vus: 20,
      iterations: 25,
      startTime: '2s',
      exec: 'replayDuplicateWebhook',
    },
    // 3. Out-of-order delivery (invoice.paid arrives BEFORE invoice.finalized)
    out_of_order_and_race: {
      executor: 'shared-iterations',
      vus: 20,
      iterations: 500,
      startTime: '5s',
      exec: 'outOfOrderPaymentRace',
    },
  },
  thresholds: {
    // Section 13 Success Metric: Webhook acknowledgement under 200ms at p95
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
  },
};

function signStripePayload(payloadStr) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payloadStr}`;
  const signature = crypto.hmac(
    'sha256',
    WEBHOOK_SECRET,
    signedPayload,
    'hex',
  );
  return `t=${timestamp},v1=${signature}`;
}

function postStripeEvent(eventObj) {
  const body = JSON.stringify(eventObj);
  const sigHeader = signStripePayload(body);

  return http.post(`${BASE_URL}/webhooks/stripe`, body, {
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': sigHeader,
    },
  });
}

export function ingestFinalizedInvoice() {
  const seq = exec.scenario.iterationInTest + 1;
  const invoiceId = `in_loadtest_${seq}`;
  const eventId = `evt_finalized_${seq}`;
  const nowSec = Math.floor(Date.now() / 1000);

  const event = {
    id: eventId,
    object: 'event',
    type: 'invoice.finalized',
    created: nowSec,
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        number: `INV-LT-${seq}`,
        status: 'open',
        customer_email: `customer_${seq}@loadtest.example.com`,
        customer_name: `Customer ${seq}`,
        amount_due: 19900,
        currency: 'usd',
        due_date: nowSec,
        created: nowSec,
        hosted_invoice_url: `https://invoice.stripe.com/i/loadtest/${invoiceId}`,
      },
    },
  };

  const res = postStripeEvent(event);
  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}

export function replayDuplicateWebhook() {
  // All 20 VUs hammer the exact same 25 event IDs simultaneously
  const idx = (exec.vu.iterationInScenario % 25) + 1;
  const invoiceId = `in_loadtest_replay_${idx}`;
  const eventId = `evt_replay_fixed_${idx}`;
  const nowSec = 1760000000;

  const event = {
    id: eventId,
    object: 'event',
    type: 'invoice.finalized',
    created: nowSec,
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        number: `INV-REPLAY-${idx}`,
        status: 'open',
        customer_email: `replay_${idx}@loadtest.example.com`,
        customer_name: `Replay User ${idx}`,
        amount_due: 45000,
        currency: 'usd',
        due_date: nowSec,
        created: nowSec,
        hosted_invoice_url: `https://invoice.stripe.com/i/loadtest/${invoiceId}`,
      },
    },
  };

  const res = postStripeEvent(event);
  check(res, {
    'replay status is 200': (r) => r.status === 200,
  });
}

export function outOfOrderPaymentRace() {
  const seq = exec.scenario.iterationInTest + 1;
  const invoiceId = `in_loadtest_race_${seq}`;
  const nowSec = Math.floor(Date.now() / 1000);

  // Step A: Deliver invoice.paid FIRST
  const paidEvent = {
    id: `evt_race_paid_${seq}`,
    object: 'event',
    type: 'invoice.paid',
    created: nowSec,
    data: {
      object: {
        id: invoiceId,
        object: 'invoice',
        number: `INV-RACE-${seq}`,
        status: 'paid',
        customer_email: `race_${seq}@loadtest.example.com`,
        customer_name: `Race User ${seq}`,
        amount_due: 89000,
        currency: 'usd',
        due_date: nowSec,
        created: nowSec,
        hosted_invoice_url: `https://invoice.stripe.com/i/loadtest/${invoiceId}`,
      },
    },
  };

  // Step B: Deliver late/out-of-order invoice.finalized (status: open) SECOND
  const finalizedEvent = {
    id: `evt_race_finalized_${seq}`,
    object: 'event',
    type: 'invoice.finalized',
    created: nowSec - 5,
    data: {
      object: {
        ...paidEvent.data.object,
        status: 'open',
      },
    },
  };

  const res1 = postStripeEvent(paidEvent);
  const res2 = postStripeEvent(finalizedEvent);

  check(res1, { 'paid event 200': (r) => r.status === 200 });
  check(res2, { 'late finalized event 200': (r) => r.status === 200 });
}