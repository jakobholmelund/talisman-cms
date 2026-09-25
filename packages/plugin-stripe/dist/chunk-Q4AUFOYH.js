// src/proxy.ts
import Stripe from "stripe";
var stripeProxy = async (args) => {
  const { stripeSecretKey, stripeMethod, stripeArgs = [] } = args;
  if (!stripeSecretKey) {
    throw new Error("Stripe secret key must be provided");
  }
  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: "2022-08-01",
    // Target recent version per docs, or user can override
    appInfo: {
      name: "Talisman CMS Stripe Plugin",
      version: "0.0.1"
    }
  });
  const methodParts = stripeMethod.split(".");
  let currentContext = stripe;
  let methodToCall = void 0;
  for (let i = 0; i < methodParts.length; i++) {
    const part = methodParts[i];
    if (part.startsWith("_")) {
      throw new Error(`Cannot access internal Stripe property: ${part}`);
    }
    if (i === methodParts.length - 1) {
      methodToCall = currentContext[part];
    } else {
      currentContext = currentContext[part];
    }
    if (!currentContext) {
      throw new Error(`Invalid Stripe method path: ${methodParts.slice(0, i + 1).join(".")}`);
    }
  }
  if (typeof methodToCall !== "function") {
    throw new Error(`The resolved Stripe property '${stripeMethod}' is not a function.`);
  }
  try {
    const result = await methodToCall.apply(currentContext, stripeArgs);
    return {
      status: 200,
      data: result
    };
  } catch (err) {
    return {
      status: err.statusCode || 500,
      message: err.message,
      type: err.type,
      code: err.code
    };
  }
};

export {
  stripeProxy
};
