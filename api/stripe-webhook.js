// POST /api/stripe-webhook -- Stripe calls this when someone pays, renews or cancels.
// In Stripe: Developers -> Webhooks -> Add endpoint -> https://prepbank.vercel.app/api/stripe-webhook
// Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted
const { readRawBody, adminDb, stripe, verifyStripeSignature } = require("./_lib");

const ACTIVE = new Set(["active", "trialing", "past_due"]);

async function setSubscription(userId, fields) {
  if (!userId) return;
  await adminDb("subscriptions?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ user_id: userId, ...fields }]),
  });
}

async function applyStripeSubscription(sub, fallbackUserId) {
  const userId = (sub.metadata && sub.metadata.user_id) || fallbackUserId;
  const periodEnd = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  await setSubscription(userId, {
    status: ACTIVE.has(sub.status) ? "active" : "free",
    plan: "prepbank_plus_monthly",
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    unlocked_at: ACTIVE.has(sub.status) ? new Date().toISOString() : null,
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const raw = await readRawBody(req);
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: "Bad signature" });
  }
  try {
    const event = JSON.parse(raw.toString("utf8"));
    const obj = event.data.object;
    if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const sub = await stripe("GET", `subscriptions/${obj.subscription}`);
      await applyStripeSubscription(sub, userId);
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await applyStripeSubscription(obj);
    }
    res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message }); // Stripe will retry
  }
};

// Stripe signatures are computed over the exact raw bytes, so don't let Vercel parse the body.
module.exports.config = { api: { bodyParser: false } };
