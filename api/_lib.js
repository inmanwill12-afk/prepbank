// Shared helpers for the /api functions. Files starting with "_" are not
// deployed as endpoints by Vercel -- this is only imported by the others.
//
// Environment variables (Vercel -> Project -> Settings -> Environment Variables):
//   STRIPE_SECRET_KEY          sk_live_... or sk_test_...   (secret)
//   STRIPE_WEBHOOK_SECRET      whsec_...                    (secret)
//   SUPABASE_SERVICE_ROLE_KEY  Supabase "secret" key (sb_secret_...)  (secret)
//   PREPBANK_PRICE_CENTS       optional, default 300 ($3.00/month)
//   SITE_URL                   optional, default https://prepbank.vercel.app

const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://zignzktrjsiklwepuhom.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_XH-grmaO8yT9gqgDf5__FQ_pAL0Zo2r";
const SITE_URL = (process.env.SITE_URL || "https://prepbank.vercel.app").replace(/\/$/, "");
const PRICE_CENTS = parseInt(process.env.PREPBANK_PRICE_CENTS || "300", 10);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const raw = (await readRawBody(req)).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// Who is calling? Verifies the user's Supabase session token.
async function getUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return r.json();
}

// Server-side database access with the service role (bypasses RLS).
async function adminDb(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Server is missing SUPABASE_SERVICE_ROLE_KEY.");
  const headers = { apikey: key, "Content-Type": "application/json", ...(opts.headers || {}) };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; // legacy JWT-style key
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error((data && data.message) || `Database error ${r.status}`);
  return data;
}

// Minimal Stripe API client (form-encoded, no SDK needed).
function formEncode(obj, prefix) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") parts.push(formEncode(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.filter(Boolean).join("&");
}

async function stripe(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Payments aren't set up yet (missing STRIPE_SECRET_KEY).");
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? formEncode(params) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.error && data.error.message) || `Stripe error ${r.status}`);
  return data;
}

// Verifies the Stripe-Signature header so nobody can fake a "payment succeeded" call.
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; })
  );
  const t = parts.t;
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex");
  return sigs.some((s) => {
    const a = Buffer.from(s, "hex"), b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

module.exports = {
  SITE_URL, PRICE_CENTS, readRawBody, readJson, getUser, adminDb, stripe, verifyStripeSignature, formEncode,
};
