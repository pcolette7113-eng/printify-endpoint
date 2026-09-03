const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.PRINTIFY_API_SECRET || "change-me";
const DB_FILE = path.join(__dirname, "products.json");

function loadProducts() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch {}
  return {};
}
function saveProducts(p) { fs.writeFileSync(DB_FILE, JSON.stringify(p, null, 2)); }

function authenticate(req, res, next) {
  const token = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (token !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/", (req, res) => res.json({ status: "ok", store: "Revealing Treasures" }));

app.get("/products", authenticate, (req, res) => {
  res.json({ products: Object.values(loadProducts()) });
});

app.post("/products", authenticate, (req, res) => {
  const data = req.body;
  if (!data || !data.id) return res.status(400).json({ error: "Missing product data" });
  const products = loadProducts();
  products[String(data.id)] = { ...data, published: true, published_at: new Date().toISOString() };
  saveProducts(products);
  console.log(`Published: ${data.title}`);
  res.status(200).json({ id: String(data.id) });
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

app.post("/webhooks/orders", (req, res) => {
  console.log("Order received:", JSON.stringify(req.body));
  res.status(200).json({ received: true });
});

app.listen(PORT, () => console.log(`Printify endpoint running on port ${PORT}`));
