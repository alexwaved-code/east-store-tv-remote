/** Ad IDs by language — keep in sync with public/shared/ads.js */
export const ADS_IDS = {
  zh: ["fan-023", "vac-002", "iron-004", "lamp-010", "ket-011", "bag-007"],
  en: ["fan-023", "vac-002", "iron-004", "lamp-010", "ket-011", "bag-007"],
};

export function idsFor(lang) {
  return [...(ADS_IDS[lang === "en" ? "en" : "zh"] || ADS_IDS.zh)];
}

export function shuffleIds(ids) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
