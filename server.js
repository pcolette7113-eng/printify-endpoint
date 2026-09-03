const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();

const PORT = process.env.PORT || 3001;
const PRINTIFY_API_SECRET  = process.env.PRINTIFY_API_SECRET  || "change-me";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PRINTIFY_API_TOKEN   = process.env.PRINTIFY_API_TOKEN   || "";
const PRINTIFY_SHOP_ID     = process.env.PRINTIFY_SHOP_ID     || "28512140";

app.use("/webhooks/stripe", express.raw({ type: "application/json" }));
app.use(express.json());

const PRODUCT_MAP = JSON.parse(process.env.PRODUCT_MAP || "{}");

function printifyRequest(method, path, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: "api.printify.com",
      path: `/v1${path}`,
      method,
      headers: {
        "Authorization": `Bearer ${PRINTIFY_API_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "RevealingTreasures/1.0",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => raw += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const DB_FILE = path.join(__dirname, "products.json");
function loadProducts() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch {}
  return {};
}
function saveProducts(p) { fs.writeFileSync(DB_FILE, JSON.stringify(p, null, 2)); }

function authenticate(req, res, next) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (token !== PRINTIFY_API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", store: "Revealing Treasures", message: "Printify endpoint is live." });
});

app.get("/products", authenticate, (req, res) => {
  res.json({ products: Object.values(loadProducts()) });
});

app.post("/products", authenticate, (req, res) => {
  const data = req.body;
  if (!data || !data.id) return res.status(400).json({ error: "Missing product data" });
  const products = loadProducts();
  const id = String(data.id);
  products[id] = { ...data, id, published: true, published_at: new Date().toISOString() };
  saveProducts(products);
  console.log(`[Printify] Published: ${data.title}`);
  res.status(200).json({ id });
});

app.put("/products/:id", authenticate, (req, res) => {
  const products = loadProducts();
  if (products[req.params.id]) {
    products[req.params.id] = { ...products[req.params.id], ...req.body, updated_at: new Date().toISOString() };
    saveProducts(products);
  }
  res.status(200).json({ id: req.params.id });
});

app.delete("/products/:id", authenticate, (req, res) => {
  const products = loadProducts();
  if (products[req.params.id]) {
    products[req.params.id].published = false;
    saveProducts(products);
  }
  res.status(200).json({ id: req.params.id });
});

app.post("/webhooks/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!STRIPE_WEBHOOK_SECRET || !sig) {
    console.warn("[Stripe] No webhook secret — skipping verification.");
  } else {
    try {
      verifyStripeSignature(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("[Stripe] Signature failed:", err.message);
      return res.status(400).json({ error: "Invalid signature" });
    }
  }

  let event;
  try { event = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: "Invalid JSON" }); }

  console.log(`[Stripe] Event: ${event.type}`);

  if (event.type !== "checkout.session.completed") {
    return res.status(200).json({ received: true, action: "ignored" });
  }

  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return res.status(200).json({ received: true, action: "not paid" });
  }

  try {
    await fulfillOrder(session);
    res.status(200).json({ received: true, action: "fulfilled" });
  } catch (err) {
    console.error("[Fulfillment] Error:", err.message);
    res.status(200).json({ received: true, action: "error", error: err.message });
  }
});

function verifyStripeSignature(payload, header, secret) {
  const parts = header.split(",").reduce((acc, part) => {
    const [key, val] = part.split("=");
    acc[key] = val;
    return acc;
  }, {});
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) throw new Error("Missing signature parts");
  const signed = `${timestamp}.${payload.toString()}`;
  const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
  if (expected !== sig) throw new Error("Signature mismatch");
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new Error("Webhook too old");
}

async function fulfillOrder(session) {
  const shipping = session.shipping_details || session.shipping;
  const customer = session.customer_details || {};
  if (!shipping || !shipping.address) throw new Error("No shipping address in session");
  const addr = shipping.address;
  const lineItems = buildLineItems(session);
  if (lineItems.length === 0) throw new Error("No Printify line items could be mapped");
  const order = {
    external_id: session.id,
    label: `Stripe Order — ${session.id.slice(-8).toUpperCase()}`,
    line_items: lineItems,
    shipping_method: 1,
    send_shipping_notification: true,
    address_to: {
      first_name: (shipping.name || customer.name || "Customer").split(" ")[0],
      last_name:  (shipping.name || customer.name || "Customer").split(" ").slice(1).join(" ") || ".",
      email:      customer.email || "",
      phone:      customer.phone || "",
      country:    addr.country || "US",
      region:     addr.state || "",
      address1:   addr.line1 || "",
      address2:   addr.line2 || "",
      city:       addr.city || "",
      zip:        addr.postal_code || "",
    },
  };
  console.log(`[Fulfillment] Submitting order for ${customer.email}`);
  const result = await printifyRequest("POST", `/shops/${PRINTIFY_SHOP_ID}/orders.json`, order);
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`Printify order failed: ${JSON.stringify(result.data)}`);
  }
  console.log(`[Fulfillment] ✅ Order created: ${result.data.id}`);
  return result.data;
}

function buildLineItems(session) {
  const items = [];
  const stripeItems = session.line_items?.data || [];
  for (const item of stripeItems) {
    const priceId = item.price?.id;
    const mapping = PRODUCT_MAP[priceId];
    if (mapping) {
      items.push({ product_id: mapping.printifyProductId, variant_id: mapping.variantId, quantity: item.quantity || 1 });
    }
  }
  if (items.length === 0 && session.metadata) {
    const { printify_product_id, printify_variant_id } = session.metadata;
    if (printify_product_id && printify_variant_id) {
      items.push({ product_id: printify_product_id, variant_id: parseInt(printify_variant_id), quantity: 1 });
    }
  }
  return items;
}

app.listen(PORT, () => console.log(`Revealing Treasures — Printify endpoint running on port ${PORT}`));




