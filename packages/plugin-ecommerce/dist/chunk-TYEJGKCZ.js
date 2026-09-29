import {
  clientOverLimit
} from "./chunk-OPQXEAZM.js";

// src/basket-limits.ts
var NEW_BASKETS_PER_NETWORK_PER_HOUR = 20;
var NEW_BASKET_WINDOW_SECONDS = 60 * 60;
var BASKET_LIMIT_MESSAGE = "Too many new baskets. Please try again later.";
function basketLimitResponse() {
  return Response.json(
    { error: BASKET_LIMIT_MESSAGE },
    { status: 429, headers: { "Retry-After": String(NEW_BASKET_WINDOW_SECONDS) } }
  );
}
function basketCreationOverLimit(env, sourceIp) {
  return clientOverLimit(env, "basket-create", sourceIp, {
    limit: NEW_BASKETS_PER_NETWORK_PER_HOUR,
    windowSeconds: NEW_BASKET_WINDOW_SECONDS
  });
}

export {
  BASKET_LIMIT_MESSAGE,
  basketLimitResponse,
  basketCreationOverLimit
};
