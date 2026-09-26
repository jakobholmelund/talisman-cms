// src/money.ts
function currencyMinorUnits(currency) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}
function formatMoney(amount, currency, locale = "en-US") {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(fromMinorUnits(amount, currency));
}
function toMinorUnits(major, currency) {
  return Math.round(major * 10 ** currencyMinorUnits(currency));
}
function fromMinorUnits(amount, currency) {
  return amount / 10 ** currencyMinorUnits(currency);
}
var MINIMUM_CHARGES = /* @__PURE__ */ new Map([
  ["usd", 50],
  ["aed", 200],
  ["aud", 50],
  ["bgn", 100],
  ["brl", 50],
  ["cad", 50],
  ["chf", 50],
  ["czk", 1500],
  ["dkk", 250],
  ["eur", 50],
  ["gbp", 30],
  ["hkd", 400],
  ["huf", 17500],
  ["inr", 50],
  ["jpy", 50],
  ["mxn", 1e3],
  ["myr", 200],
  ["nok", 300],
  ["nzd", 50],
  ["pln", 200],
  ["ron", 200],
  ["sek", 300],
  ["sgd", 50],
  ["thb", 1e3]
]);
var SUPPORTED_CURRENCIES = Object.freeze([...MINIMUM_CHARGES.keys()]);
function isSupportedCurrency(currency) {
  return MINIMUM_CHARGES.has(currency.toLowerCase());
}
function minimumChargeAmount(currency) {
  return MINIMUM_CHARGES.get(currency.toLowerCase()) ?? 50;
}

export {
  currencyMinorUnits,
  formatMoney,
  toMinorUnits,
  fromMinorUnits,
  SUPPORTED_CURRENCIES,
  isSupportedCurrency,
  minimumChargeAmount
};
