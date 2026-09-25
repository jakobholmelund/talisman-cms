import { F as FieldDefinition, G as GlobalConfig } from './types-DZZq-VQM.js';

interface SeoSiteSettings {
    siteName?: string;
    titleSuffix?: string;
    defaultDescription?: string;
    defaultImage?: string;
    organizationName?: string;
    organizationLogo?: string;
    sameAs?: string;
    [key: string]: unknown;
}
interface SeoPageSettings {
    title?: string;
    description?: string;
    image?: string;
    noindex?: boolean;
    canonicalPath?: string;
    type?: 'WebPage' | 'CollectionPage' | 'AboutPage';
    breadcrumbs?: Array<{
        name: string;
        path: string;
    }>;
}
interface ResolvedSeo {
    title: string;
    description: string;
    canonical: string;
    image?: string;
    robots: 'index, follow' | 'noindex, nofollow';
    openGraphType: 'website';
    jsonLd: Record<string, unknown>[];
}
/** Add editable SEO overrides to a CMS collection. */
declare function createSeoFields(prefix?: string, label?: string): FieldDefinition[];
/** Register this global in talismanCms({ globals }) for editable site defaults. */
declare function createSeoGlobal(options?: {
    slug?: string;
    pages?: Array<{
        key: string;
        label: string;
    }>;
}): GlobalConfig;
/** Read one fixed page's editable fields from the Site SEO global. */
declare function seoPageFromGlobal(site: SeoSiteSettings, key: string): SeoPageSettings;
/** Talisman globals store JSON in `data`; this also accepts already parsed values. */
declare function parseSeoSiteSettings(value: unknown): SeoSiteSettings;
declare function resolveSeo(options: {
    siteUrl: string;
    path: string;
    site: SeoSiteSettings;
    page: SeoPageSettings;
    /** A deployment owned launch gate. CMS editors cannot override false. */
    publicIndexing: boolean;
}): ResolvedSeo;
declare function serializeJsonLd(value: unknown): string;
declare function renderRobotsTxt(options: {
    siteUrl: string;
    publicIndexing: boolean;
    disallowPaths?: string[];
    aiSearch?: boolean;
    aiTraining?: boolean;
}): string;
declare function renderSitemapXml(site: string, paths: string[]): string;

export { type ResolvedSeo, type SeoPageSettings, type SeoSiteSettings, createSeoFields, createSeoGlobal, parseSeoSiteSettings, renderRobotsTxt, renderSitemapXml, resolveSeo, seoPageFromGlobal, serializeJsonLd };
