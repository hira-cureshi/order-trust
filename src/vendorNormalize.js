// vendorNormalize.js — solves the exact problem lumine flagged: Shopify's
// vendor field is free text, so "Soeji", "soeji", and "Soeji37" all read as
// different suppliers unless something merges them first. This runs BEFORE
// any order data is saved, not after — so nothing downstream ever sees the
// messy raw versions as if they were separate suppliers.

const db = require("./db");

// Basic automatic cleanup: trim whitespace, collapse internal spaces,
// lowercase for comparison, strip common trailing noise (store numbers,
// stray punctuation). This catches the majority of casing/whitespace
// duplicates automatically.
function autoClean(rawVendor) {
  if (!rawVendor) return "Unknown Vendor";
  return rawVendor
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[_-]+$/g, "")
    .replace(/\s*\d+$/, ""); // trims trailing store/number suffixes like "Soeji37" -> "Soeji"
}

// Title-cases the cleaned name for consistent display (doesn't affect the
// matching logic, which is case-insensitive underneath).
function toDisplayCase(name) {
  return name
    .split(" ")
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// The main entry point. Given a shop and a raw vendor string from Shopify,
// returns the normalized name to actually store and score against.
// Remembers past decisions per shop so the same raw string always maps to
// the same normalized name, and so a merchant could later correct a
// mapping manually (future feature — the table already supports it).
function normalizeVendor(shopDomain, rawVendor) {
  const raw = (rawVendor || "").trim();
  if (!raw) return "Unknown Vendor";

  const existing = db
    .prepare(`SELECT normalized_vendor FROM vendor_aliases WHERE shop_domain = ? AND raw_vendor = ?`)
    .get(shopDomain, raw);
  if (existing) return existing.normalized_vendor;

  // No exact mapping yet — check if a cleaned version matches an already-
  // known normalized vendor for this shop (case-insensitive), so "soeji"
  // merges into an existing "Soeji" rather than creating a near-duplicate.
  const cleaned = toDisplayCase(autoClean(raw));
  const candidates = db
    .prepare(`SELECT DISTINCT normalized_vendor FROM vendor_aliases WHERE shop_domain = ?`)
    .all(shopDomain);
  const match = candidates.find(
    (c) => c.normalized_vendor.toLowerCase() === cleaned.toLowerCase()
  );
  const finalName = match ? match.normalized_vendor : cleaned;

  db.prepare(
    `INSERT INTO vendor_aliases (shop_domain, raw_vendor, normalized_vendor) VALUES (?, ?, ?)
     ON CONFLICT(shop_domain, raw_vendor) DO NOTHING`
  ).run(shopDomain, raw, finalName);

  return finalName;
}

module.exports = { normalizeVendor, autoClean, toDisplayCase };
