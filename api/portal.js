// POST /api/portal -> { url } of the Stripe customer portal (cancel / update card / receipts).
const { SITE_URL, getUser, adminDb, stripe } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in again." });
    const rows = await adminDb(`subscriptions?user_id=eq.${user.id}&select=stripe_customer_id`);
    const customer = rows && rows[0] && rows[0].stripe_customer_id;
    if (!customer) return res.status(400).json({ error: "No billing account found for you yet." });
    const portal = await stripe("POST", "billing_portal/sessions", { customer, return_url: SITE_URL });
    res.status(200).json({ url: portal.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Couldn't open billing." });
  }
};
