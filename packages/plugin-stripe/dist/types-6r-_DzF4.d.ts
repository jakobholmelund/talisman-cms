interface StripeSyncConfig {
    collection: string;
    stripeResourceType: 'customers' | 'products' | 'prices';
    stripeResourceTypeSingular: 'customer' | 'product' | 'price';
    /**
     * Note: As Talisman CMS doesn't fully support automatic 2-way sync yet, these fields aren't
     * automatically synced, but they establish the data model for the underlying collections.
     */
    fields?: {
        fieldPath: string;
        stripeProperty: string;
    }[];
}
interface StripePluginConfig {
    /**
     * Your Stripe secret key
     */
    stripeSecretKey: string;
    /**
     * Your Stripe webhook endpoint secret
     */
    stripeWebhooksEndpointSecret?: string;
    /**
     * When `true`, opens the `/api/stripe/rest` endpoint
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
     * Either a function to handle all webhooks events,
     * or an object of Stripe webhook handlers, keyed to the name of the event type.
     */
    webhooks?: Record<string, (event: any) => void | Promise<void>> | ((event: any) => void | Promise<void>);
    /** Server module export containing webhook handlers; required when webhooks is set. */
    webhooksModule?: {
        moduleId: string;
        exportName: string;
    };
    /**
     * When `true`, logs sync/webhook events to the console as they happen
     * @default false
     */
    logs?: boolean;
}

export type { StripePluginConfig as S, StripeSyncConfig as a };
