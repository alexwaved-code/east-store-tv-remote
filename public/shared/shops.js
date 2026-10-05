export const FIXED_SHOPS = {};

export function shopByCode() {
  return null;
}

export function shopLabel() {
  return "";
}

export function isFixedShopCode() {
  return false;
}

export function normalizeShopCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
}
