import Stripe from 'stripe';

export interface StripeProxyArgs {
  stripeSecretKey: string;
  stripeMethod: string;
  stripeArgs?: any[];
}

/**
 * A utility to securely invoke Stripe SDK methods on the server side.
 * Proxies calls like `customers.create` dynamically.
 * 
 * @param args Request payload
 * @returns Serialized Response from Stripe
 */
export const stripeProxy = async (args: StripeProxyArgs): Promise<any> => {
  const { stripeSecretKey, stripeMethod, stripeArgs = [] } = args;

  if (!stripeSecretKey) {
    throw new Error('Stripe secret key must be provided');
  }

  const stripe = new Stripe(stripeSecretKey, {
    apiVersion: '2022-08-01' as any, // Target recent version per docs, or user can override
    // fetch works in Workers and Node alike
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: {
      name: 'Talisman CMS Stripe Plugin',
      version: '0.0.1',
    },
  });

  const methodParts = stripeMethod.split('.');
  let currentContext: any = stripe;
  let methodToCall: any = undefined;

  for (let i = 0; i < methodParts.length; i++) {
    const part = methodParts[i];
    
    // Safety check: Don't allow accessing internal/private stripe fields via proxy (naive block)
    if (part.startsWith('_')) {
      throw new Error(`Cannot access internal Stripe property: ${part}`);
    }

    if (i === methodParts.length - 1) {
      methodToCall = currentContext[part];
    } else {
      currentContext = currentContext[part];
    }
    
    if (!currentContext) {
      throw new Error(`Invalid Stripe method path: ${methodParts.slice(0, i + 1).join('.')}`);
    }
  }

  if (typeof methodToCall !== 'function') {
    throw new Error(`The resolved Stripe property '${stripeMethod}' is not a function.`);
  }

  try {
    const result = await methodToCall.apply(currentContext, stripeArgs);
    return {
      status: 200,
      data: result
    };
  } catch (err: any) {
    return {
      status: err.statusCode || 500,
      message: err.message,
      type: err.type,
      code: err.code
    };
  }
};
