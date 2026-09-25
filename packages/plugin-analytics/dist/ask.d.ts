import { CommerceRange, StripeMode } from './commerce.js';
import { TrafficRange } from './cloudflare.js';

/**
 * Formats a UTC range whose end is exclusive. Whole days show dates only; when either boundary
 * is not at midnight both show the time, so partial days are never mistaken for whole ones.
 */
declare function formatRange(start: string, end: string, locale?: string): string;

type ReportSubject = 'sales' | 'products' | 'refunds' | 'traffic' | 'traffic_and_sales' | 'unsupported';
type ReportPeriod = 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'this_month' | 'last_month';
type ReportPlan = {
    subject: ReportSubject;
    period: ReportPeriod;
    compare: boolean;
};
type DateWindow = {
    label: string;
    start: string;
    end: string;
};
type AskReport = {
    question: string;
    subject: Exclude<ReportSubject, 'unsupported'>;
    title: string;
    period: DateWindow;
    previous?: DateWindow;
    summary: string;
    commerce?: CommerceRange;
    previousCommerce?: CommerceRange;
    traffic?: TrafficRange;
    previousTraffic?: TrafficRange;
    notes: string[];
};
type AiBinding = {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
};
type Database = Pick<D1Database, 'prepare'>;
declare function validateReportPlan(value: unknown): ReportPlan;
declare function planReport(question: string, ai: AiBinding): Promise<ReportPlan>;
declare function reportWindow(period: ReportPeriod, now?: Date): DateWindow;
/**
 * The window a report is compared with. Partial periods are compared with the same span of the
 * period before: today with yesterday up to the same time, this month with last month up to the
 * same day and time (all of last month when this month is already longer).
 */
declare function precedingWindow(window: DateWindow, period?: ReportPeriod): DateWindow;
/** `stripeMode` is the store's Stripe mode (see StripeMode): test-mode orders count only in `test` mode. */
declare function createAskReport(question: string, ai: AiBinding, db: Database, env: Record<string, unknown>, adminBase?: string, productCollectionSlug?: string, stripeMode?: StripeMode, now?: Date, fetcher?: typeof fetch): Promise<AskReport>;

export { type AskReport, type DateWindow, type ReportPeriod, type ReportPlan, type ReportSubject, createAskReport, formatRange, planReport, precedingWindow, reportWindow, validateReportPlan };
