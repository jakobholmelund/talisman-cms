import { CommerceRange } from './commerce.js';
import { TrafficRange } from './cloudflare.js';

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
declare function precedingWindow(window: DateWindow, period?: ReportPeriod): DateWindow;
declare function createAskReport(question: string, ai: AiBinding, db: Database, env: Record<string, unknown>, adminBase?: string, productCollectionSlug?: string, now?: Date, fetcher?: typeof fetch): Promise<AskReport>;

export { type AskReport, type DateWindow, type ReportPeriod, type ReportPlan, type ReportSubject, createAskReport, planReport, precedingWindow, reportWindow, validateReportPlan };
