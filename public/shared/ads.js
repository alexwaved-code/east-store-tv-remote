/** Demo catalogue for screenshots. Replace with your own ads. */

export const BRAND_CHIPS = ["East Home", "East Care", "East Kitchen"];

const DEMO = [
  { id: "fan-023", name: "充電式桌面噴霧風扇", line: "East Home", cover: "covers/fan.svg", sku: "FAN-023-WH", price: "$199", info: "4000mAh · USB-C" },
  { id: "vac-002", name: "無線高速吸塵機", line: "East Home", cover: "covers/vac.svg", sku: "VAC-002", price: "$899", info: "BLDC · 45 分鐘" },
  { id: "iron-004", name: "鈦金屬直髮夾", line: "East Care", cover: "covers/iron.svg", sku: "IRON-004", price: "$329", info: "30 秒預熱" },
  { id: "lamp-010", name: "礦物鹽燈", line: "East Home", cover: "covers/lamp.svg", sku: "LAMP-010", price: "$129", info: "暖光 · 小夜燈" },
  { id: "ket-011", name: "養生壺", line: "East Kitchen", cover: "covers/ket.svg", sku: "KET-011", price: "$259", info: "多段溫控" },
  { id: "bag-007", name: "摺疊購物車", line: "East Home", cover: "covers/bag.svg", sku: "BAG-007", price: "$159", info: "25kg · 萬向輪" },
];

const DEMO_EN = [
  { id: "fan-023", name: "Desk misting fan", line: "East Home", cover: "covers/fan.svg", sku: "FAN-023-WH", price: "$199", info: "4000mAh · USB-C" },
  { id: "vac-002", name: "Cordless vacuum", line: "East Home", cover: "covers/vac.svg", sku: "VAC-002", price: "$899", info: "BLDC · 45 min" },
  { id: "iron-004", name: "Titanium straightener", line: "East Care", cover: "covers/iron.svg", sku: "IRON-004", price: "$329", info: "30s heat" },
  { id: "lamp-010", name: "Salt lamp", line: "East Home", cover: "covers/lamp.svg", sku: "LAMP-010", price: "$129", info: "Warm night light" },
  { id: "ket-011", name: "Health kettle", line: "East Kitchen", cover: "covers/ket.svg", sku: "KET-011", price: "$259", info: "Multi-temp" },
  { id: "bag-007", name: "Folding trolley", line: "East Home", cover: "covers/bag.svg", sku: "BAG-007", price: "$159", info: "25kg · caster" },
];

export const ADS = { zh: DEMO, en: DEMO_EN };

export function adsFor(lang) {
  return ADS[lang === "en" ? "en" : "zh"] || ADS.zh;
}

export function findAd(lang, id) {
  if (!id) return null;
  return (
    adsFor(lang).find((a) => a.id === id) ||
    ADS.zh.find((a) => a.id === id) ||
    ADS.en.find((a) => a.id === id) ||
    null
  );
}

export function idsFor(lang) {
  return adsFor(lang).map((a) => a.id);
}

export function shuffleIds(ids) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
