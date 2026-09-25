import {
  stripeProxy
} from "../chunk-3PUM3JYR.js";
import {
  MISSING_SECRET_KEY,
  getWorkerEnv,
  readStripeSecretKey
} from "../chunk-W7JZMBL7.js";

// src/routes/rest.ts
import { authorizeCmsRequest } from "talisman-cms/auth/guard";
import { stripeConfig } from "virtual:talisman-cms/stripe-config";
var POST = async ({ request }) => {
  const authorization = await authorizeCmsRequest(request, "admin");
  if (authorization.response) return authorization.response;
  const config = stripeConfig;
  if (!config) {
    return new Response(JSON.stringify({ error: "Stripe plugin config not found in global scope" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (config.rest !== true) {
    return new Response(JSON.stringify({ error: "REST endpoint is not enabled" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }
  try {
    const body = await request.json();
    const { stripeMethod, stripeArgs } = body;
    if (!stripeMethod) {
      return new Response(JSON.stringify({ error: "Missing stripeMethod in payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (typeof stripeMethod !== "string" || !config.restMethods?.includes(stripeMethod)) {
      return Response.json({ error: "Stripe method is not allowed" }, { status: 403 });
    }
    const stripeSecretKey = readStripeSecretKey(await getWorkerEnv());
    if (!stripeSecretKey) {
      console.error(MISSING_SECRET_KEY);
      return Response.json({ error: MISSING_SECRET_KEY }, { status: 503 });
    }
    const result = await stripeProxy({
      stripeSecretKey,
      stripeMethod,
      stripeArgs
    });
    return new Response(JSON.stringify(result), {
      status: result.status === 200 ? 200 : result.status || 500,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
export {
  POST
};
