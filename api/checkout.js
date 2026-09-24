// POST /api/checkout -> { url } of a Stripe Checkout page for PrepBank+ ($3/month).
const { SITE_URL, PRICE_CENTS, getUser, adminDb, stripe } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in again." });

    const rows = await adminDb(`subscriptions?user_id=eq.${user.id}&select=status,stripe_customer_id`);
    const sub = rows && rows[0];
    if (sub && sub.status === "active") return res.status(400).json({ error: "You already have PrepBank+." });

    const session = await stripe("POST", "checkout/sessions", {
      mode: "subscription",
      client_reference_id: user.id,
      ...(sub && sub.stripe_customer_id ? { customer: sub.stripe_customer_id } : { customer_email: user.email }),
      line_items: {
        0: {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: PRICE_CENTS,
            recurring: { interval: "month" },
            product_data: { name: "PrepBank+", description: "Every practice test for every HPISD class." },
          },
        },
      },
      metadata: { user_id: user.id },
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: "true",
      success_url: `${SITE_URL}/?checkout=success`,
      cancel_url: `${SITE_URL}/?checkout=cancel`,
    });
    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Couldn't start checkout." });
  }
};
