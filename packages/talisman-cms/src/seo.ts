import type { FieldDefinition, GlobalConfig } from './types';

export interface SeoSiteSettings {
  siteName?: string;
  titleSuffix?: string;
  defaultDescription?: string;
  defaultImage?: string;
  organizationName?: string;
  organizationLogo?: string;
  sameAs?: string;
  [key: string]: unknown;
}

export interface SeoPageSettings {
  title?: string;
  description?: string;
  image?: string;
  noindex?: boolean;
  canonicalPath?: string;
  type?: 'WebPage' | 'CollectionPage' | 'AboutPage';
  breadcrumbs?: Array<{ name: string; path: string }>;
}

export interface ResolvedSeo {
  title: string;
  description: string;
  canonical: string;
  image?: string;
  robots: 'index, follow' | 'noindex, nofollow';
  openGraphType: 'website';
  jsonLd: Record<string, unknown>[];
}

/** Add editable SEO overrides to a CMS collection. */
export function createSeoFields(prefix = '', label = ''): FieldDefinition[] {
  const key = prefix ? `${prefix}Seo` : 'seo';
  const name = label ? `${label} ` : '';
  return [
    { name: `${key}Title`, label: `${name}search title`, type: 'text' },
    { name: `${key}Description`, label: `${name}search description`, type: 'textarea' },
    { name: `${key}Image`, label: `${name}social sharing image URL`, type: 'text' },
    { name: `${key}Noindex`, label: `${name}hide from search`, type: 'boolean', defaultValue: false },
  ];
}

/** Register this global in talismanCms({ globals }) for editable site defaults. */
export function createSeoGlobal(options: { slug?: string; pages?: Array<{ key: string; label: string }> } = {}): GlobalConfig {
  for (const page of options.pages || []) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(page.key)) throw new Error('SEO page keys must start with a letter and contain only letters or digits');
  }
  return {
    name: 'Site SEO',
    slug: options.slug || 'site-seo',
    description: 'Search and social defaults. Public indexing is controlled by the site deployment.',
    fields: [
      { name: 'siteName', label: 'Site name', type: 'text' },
      { name: 'titleSuffix', label: 'Title suffix', type: 'text' },
      { name: 'defaultDescription', label: 'Default page description', type: 'textarea' },
      { name: 'defaultImage', label: 'Default social image URL', type: 'text' },
      { name: 'organizationName', label: 'Organization name', type: 'text' },
      { name: 'organizationLogo', label: 'Organization logo URL', type: 'text' },
      { name: 'sameAs', label: 'Official profile URLs (one per line)', type: 'textarea' },
      ...(options.pages || []).flatMap((page) => createSeoFields(page.key, page.label)),
    ],
  };
}

/** Read one fixed page's editable fields from the Site SEO global. */
export function seoPageFromGlobal(site: SeoSiteSettings, key: string): SeoPageSettings {
  if (!/^[a-z][A-Za-z0-9]*$/.test(key)) return {};
  return {
    title: text(site[`${key}SeoTitle`]) || undefined,
    description: text(site[`${key}SeoDescription`]) || undefined,
    image: text(site[`${key}SeoImage`]) || undefined,
    noindex: site[`${key}SeoNoindex`] === true,
  };
}

/** Talisman globals store JSON in `data`; this also accepts already parsed values. */
export function parseSeoSiteSettings(value: unknown): SeoSiteSettings {
  try {
    const data = typeof value === 'string' ? JSON.parse(value) : value;
    return data && typeof data === 'object' && !Array.isArray(data) ? data as SeoSiteSettings : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safePath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return '/';
  const url = new URL(path, 'https://talisman.invalid');
  return url.pathname;
}

function siteUrl(origin: string, path: string): string {
  const base = new URL(origin);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('SEO site URL must use HTTP or HTTPS');
  return new URL(safePath(path), base.origin).toString();
}

function absoluteImage(origin: string, value: unknown): string | undefined {
  const image = text(value);
  if (!image) return undefined;
  try {
    const url = new URL(image, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSeo(options: {
  siteUrl: string;
  path: string;
  site: SeoSiteSettings;
  page: SeoPageSettings;
  /** A deployment owned launch gate. CMS editors cannot override false. */
  publicIndexing: boolean;
}): ResolvedSeo {
  const { site, page } = options;
  const siteName = text(site.siteName);
  const rawTitle = text(page.title) || siteName;
  const suffix = text(site.titleSuffix);
  const title = suffix && rawTitle !== suffix && !rawTitle.endsWith(` — ${suffix}`)
    ? `${rawTitle} — ${suffix}` : rawTitle;
  const description = text(page.description) || text(site.defaultDescription);
  const canonical = siteUrl(options.siteUrl, page.canonicalPath || options.path);
  const image = absoluteImage(options.siteUrl, page.image || site.defaultImage);
  const organizationName = text(site.organizationName);
  const organizationLogo = absoluteImage(options.siteUrl, site.organizationLogo);
  const sameAs = text(site.sameAs).split(/\r?\n/).map((url) => url.trim()).filter((url) => {
    try { return new URL(url).protocol === 'https:'; } catch { return false; }
  });
  const jsonLd: Record<string, unknown>[] = [];

  if (safePath(options.path) === '/') {
    jsonLd.push({ '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${siteUrl(options.siteUrl, '/')}#website`,
      url: siteUrl(options.siteUrl, '/'), name: siteName || title, ...(description ? { description } : {}) });
    if (organizationName) jsonLd.push({ '@context': 'https://schema.org', '@type': 'Organization',
      '@id': `${siteUrl(options.siteUrl, '/')}#organization`, name: organizationName,
      url: siteUrl(options.siteUrl, '/'), ...(organizationLogo ? { logo: organizationLogo } : {}),
      ...(sameAs.length ? { sameAs } : {}) });
  }

  jsonLd.push({ '@context': 'https://schema.org', '@type': page.type || 'WebPage', '@id': `${canonical}#webpage`,
    url: canonical, name: title, ...(description ? { description } : {}),
    ...(image ? { primaryImageOfPage: image } : {}),
    isPartOf: { '@id': `${siteUrl(options.siteUrl, '/')}#website` } });

  if (page.breadcrumbs && page.breadcrumbs.length >= 2) {
    jsonLd.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: page.breadcrumbs.map((item, index) => ({ '@type': 'ListItem', position: index + 1,
        name: text(item.name), item: siteUrl(options.siteUrl, item.path) })) });
  }

  return { title, description, canonical, image,
    robots: options.publicIndexing && !page.noindex ? 'index, follow' : 'noindex, nofollow',
    openGraphType: 'website', jsonLd };
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function renderRobotsTxt(options: {
  siteUrl: string;
  publicIndexing: boolean;
  disallowPaths?: string[];
  aiSearch?: boolean;
  aiTraining?: boolean;
}): string {
  const lines = ['User-agent: *', 'Allow: /'];
  for (const path of options.disallowPaths || []) {
    const safe = safePath(path);
    if (safe !== '/') lines.push(`Disallow: ${safe}`);
  }
  if (options.aiSearch === false) lines.push('', 'User-agent: OAI-SearchBot', 'Disallow: /');
  if (options.aiTraining === false) {
    lines.push('', 'User-agent: GPTBot', 'Disallow: /', '', 'User-agent: Google-Extended', 'Disallow: /');
  }
  if (options.publicIndexing) lines.push('', `Sitemap: ${siteUrl(options.siteUrl, '/sitemap.xml')}`);
  return `${lines.join('\n')}\n`;
}

export function renderSitemapXml(site: string, paths: string[]): string {
  const urls = [...new Set(paths.map((path) => siteUrl(site, path)))];
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${xml(url)}</loc></url>`).join('\n')}\n</urlset>\n`;
}
