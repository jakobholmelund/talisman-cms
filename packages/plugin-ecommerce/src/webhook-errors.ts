/**
 * How the webhook route answers a payment provider event that it could not apply. An event without
 * this store's references is answered 200 and changes nothing; these errors cover the rest.
 */

/** The event's signature or payload was refused. The webhook route answers 400. */
export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
}

/**
 * The event names one of this store's orders or gift card purchases whose payment is not recorded
 * yet, for example a refund that arrives before the payment is confirmed. The webhook route answers
 * 409, so the provider delivers the event again later.
 */
export class WebhookRetryLaterError extends Error {
  override readonly name = 'WebhookRetryLaterError';
}

/**
 * The event names one of this store's records but cannot be applied, and no retry will change that,
 * such as an amount or currency that does not match. The webhook logs it at error level and answers
 * 200 with `reason`, so the provider neither retries it for days nor disables the endpoint.
 */
export class WebhookMismatchError extends Error {
  override readonly name = 'WebhookMismatchError';
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}
