export interface StripeSyncConfig {
  collection: string;
  stripeResourceType: 'customers' | 'products' | 'prices';
  stripeResourceTypeSingular: 'customer' | 'product' | 'price';
  /**
   * Field that stores the linked Stripe ID. For a native collection this must be a column of the
   * mapped table, named by its Drizzle property.
   * @default 'stripeID'
   */
  stripeIdField?: string;
  /**
   * CMS fields copied to the Stripe resource whenever a record is created or updated. Sync is
   * one-way: changes made in the Stripe Dashboard are not copied back.
   */
  fields?: {
    fieldPath: string;
    stripeProperty: string;
  }[];
}

export type StripeWebhookHandlers =
  | Record<string, (event: any) => void | Promise<void>>
  | ((event: any) => void | Promise<void>);

export interface StripePluginConfig {
  /**
   * @deprecated Ignored. Set the `STRIPE_SECRET_KEY` Worker secret instead, so the key never
   * reaches `astro.config` or the server bundle.
   */
  stripeSecretKey?: string;

  /**
   * @deprecated Ignored. Set the `TALISMAN_STRIPE_WEBHOOK_SECRET` Worker secret instead.
   */
  stripeWebhooksEndpointSecret?: string;

  /**
   * When `true`, opens the admin-only `<adminPath>/api/stripe/rest` endpoint for `restMethods`
   * @default false
   */
  rest?: boolean;

  /** Explicit Stripe SDK methods that administrators may call through REST. */
  restMethods?: string[];

  /**
   * An array of sync configs.
   */
  sync?: StripeSyncConfig[];

  /**
   * Serves the public `/api/stripe/webhooks` endpoint, which verifies each event with the
   * `TALISMAN_STRIPE_WEBHOOK_SECRET` Worker secret.
   * @default true when `webhooksModule` is set, otherwise false
   */
  webhookEndpoint?: boolean;

  /**
   * Either a function to handle all webhooks events,
   * or an object of Stripe webhook handlers, keyed to the name of the event type.
   */
  webhooks?: StripeWebhookHandlers;

  /** Server module export containing webhook handlers; required when webhooks is set. */
  webhooksModule?: { moduleId: string; exportName: string };

  /**
   * When `true`, logs sync/webhook events to the console as they happen
   * @default false
   */
  logs?: boolean;
}

/** The options compiled into the server bundle. It holds no secrets. */
export interface StripeRuntimeConfig {
  rest: boolean;
  restMethods: string[];
  logs: boolean;
  webhooks?: StripeWebhookHandlers;
}
