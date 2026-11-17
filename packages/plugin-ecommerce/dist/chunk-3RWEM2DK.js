import {
  SHIPPING_OPTION_UNAVAILABLE,
  UNDELIVERABLE_COUNTRY
} from "./chunk-YHTTKGNB.js";
import {
  ShopperError
} from "./chunk-3MXMGN5I.js";
import {
  isCountryCode
} from "./chunk-USNNZXV4.js";

// src/shipping.ts
function shippingOptionsFor(settings, country, itemsAmount) {
  return ratesServing(settings, country).map((rate) => ({
    id: rate.id,
    label: rate.label,
    amount: shippingCharge(rate, itemsAmount),
    description: deliveryEstimate(rate),
    freeOver: rate.freeOver,
    minDays: rate.minDays,
    maxDays: rate.maxDays
  }));
}
function ratesServing(settings, country) {
  const code = typeof country === "string" ? country.trim().toUpperCase() : "";
  if (!isCountryCode(code) || settings.deliveryCountries && !settings.deliveryCountries.includes(code)) return [];
  return settings.shippingRates.filter((rate) => !rate.countries || rate.countries.includes(code));
}
function chooseShippingRate(settings, country, chosenId) {
  const serving = ratesServing(settings, country);
  if (!serving.length) throw new ShopperError("checkout_details", UNDELIVERABLE_COUNTRY, 400);
  const chosen = chosenId?.trim();
  const rate = chosen ? serving.find((candidate) => candidate.id === chosen) : serving[0];
  if (!rate) throw new ShopperError("checkout_details", SHIPPING_OPTION_UNAVAILABLE, 400);
  return rate;
}
function shippingCharge(rate, itemsAmount) {
  return rate.freeOver !== null && itemsAmount >= rate.freeOver ? 0 : rate.amount;
}
function deliveryEstimate(rate) {
  const days = (count) => `${count} business day${count === 1 ? "" : "s"}`;
  const { minDays, maxDays } = rate;
  if (minDays !== null && maxDays !== null) {
    return `Delivery in ${minDays === maxDays ? days(maxDays) : `${minDays}\u2013${days(maxDays)}`}`;
  }
  if (maxDays !== null) return `Delivery in up to ${days(maxDays)}`;
  if (minDays !== null) return `Delivery in at least ${days(minDays)}`;
  return null;
}

export {
  shippingOptionsFor,
  chooseShippingRate,
  shippingCharge,
  deliveryEstimate
};
