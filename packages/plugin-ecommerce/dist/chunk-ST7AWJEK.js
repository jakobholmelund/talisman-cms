import {
  clientOverLimit,
  countRequest
} from "./chunk-CDRJWRSQ.js";

// src/code-check-limits.ts
var CODE_CHECKS_PER_NETWORK_PER_HOUR = 30;
var CODE_CHECKS_PER_BASKET_PER_HOUR = 10;
var CODE_CHECK_WINDOW_SECONDS = 60 * 60;
var CODE_CHECK_LIMIT_MESSAGE = "Too many code checks. Please try again later.";
function codeChecksOverNetworkLimit(env, sourceIp, now) {
  return clientOverLimit(
    env,
    "code-check",
    sourceIp,
    { limit: CODE_CHECKS_PER_NETWORK_PER_HOUR, windowSeconds: CODE_CHECK_WINDOW_SECONDS, now }
  );
}
async function codeChecksOverBasketLimit(env, cartId, now) {
  const count = await countRequest(env, `code-check-basket:${cartId}`, now, CODE_CHECK_WINDOW_SECONDS);
  return (count ?? CODE_CHECKS_PER_BASKET_PER_HOUR + 1) > CODE_CHECKS_PER_BASKET_PER_HOUR;
}

export {
  CODE_CHECK_LIMIT_MESSAGE,
  codeChecksOverNetworkLimit,
  codeChecksOverBasketLimit
};
