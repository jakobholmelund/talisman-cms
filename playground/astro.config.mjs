// @ts-check
import { defineConfig, envField } from 'astro/config';
import talismanCms from 'talisman-cms';
import { LocalAuthAdapter } from 'talisman-cms/auth/local';
import {
  createCollectionRepeaterBlock,
  createSectionLayoutBlock,
  createThreeColumnLayoutBlock,
  createTwoColumnLayoutBlock,
} from 'talisman-cms/helpers';
import { ecommercePlugin } from '@talisman-cms/plugin-ecommerce';
import { analyticsPlugin } from '@talisman-cms/plugin-analytics';
import { daisyUiPlugin } from '@talisman-cms/plugin-ui-daisyui';
import { starwindUiPlugin } from '@talisman-cms/plugin-ui-starwind';
import { stripePlugin } from '@talisman-cms/plugin-stripe';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    imageService: 'cloudflare',
    inspectorPort: false
  }),
  image: {
    remotePatterns: [
      { protocol: 'https' },
      { protocol: 'http' },
    ],
  },
  env: {
    schema: {
      STRIPE_SECRET_KEY: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
        default: 'sk_test_mockkey',
      }),
      STRIPE_WEBHOOK_SECRET: envField.string({
        context: 'server',
        access: 'secret',
        optional: true,
        default: 'whsec_mockkey',
      }),
      PUBLIC_SITE_URL: envField.string({
        context: 'client',
        access: 'public',
        optional: true,
        default: 'http://localhost:4321',
      }),
    },
  },
  security: {
    csp: true
  },
  vite: {
    plugins: [tailwindcss()]
  },
  integrations: [talismanCms({
    auth: LocalAuthAdapter(),
    publishing: {
      workflowBinding: 'TALISMAN_PUBLISH_WORKFLOW'
    },
    globals: [
      {
        name: 'Site Settings',
        slug: 'site-settings',
        description: 'Singleton settings that control core marketing and brand content.',
        fields: [
          { name: 'title', label: 'Site Title', type: 'text', required: true, defaultValue: 'Talisman Storefront' },
          { name: 'theme', label: 'Theme', type: 'select', options: ['light', 'dark', 'system'], defaultValue: 'system' },
          { name: 'showBanner', label: 'Show Announcement Banner', type: 'boolean', defaultValue: true },
          { name: 'announcement', label: 'Announcement Copy', type: 'textarea' },
          {
            name: 'homepage',
            label: 'Featured Homepage',
            type: 'relationship',
            relationTo: 'pages'
          },
          {
            name: 'seo',
            label: 'SEO Defaults',
            type: 'group',
            fields: [
              { name: 'metaTitle', label: 'Meta Title', type: 'text' },
              { name: 'metaDescription', label: 'Meta Description', type: 'textarea' }
            ]
          }
        ]
      }
    ],
    plugins: [
      analyticsPlugin(),
      ecommercePlugin({
        productsCollectionSlug: 'products'
      }),
      daisyUiPlugin(),
      starwindUiPlugin(),
      stripePlugin({
        stripeSecretKey: 'sk_test_mockkey', // Replace with real key in .env
        stripeWebhooksEndpointSecret: 'whsec_mockkey',
        rest: false,
        logs: true,
        sync: [
          {
            collection: 'products',
            stripeResourceType: 'products',
            stripeResourceTypeSingular: 'product',
            fields: [
              { fieldPath: 'name', stripeProperty: 'name' }
            ]
          }
        ]
      })
    ],
    collections: [
      {
        name: 'Authors',
        slug: 'authors',
        description: 'Authors for the blog',
        fields: [
          { name: 'name', label: 'Name', type: 'text', required: true }
        ]
      },
      {
        name: 'Posts',
        slug: 'posts',
        description: 'Blog posts and articles',
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'author', label: 'Author', type: 'relationship', relationTo: 'authors' },
          { name: 'content', label: 'Content', type: 'richtext' },
          { name: 'views', label: 'Views', type: 'number', defaultValue: 0 },
          { name: 'isPublished', label: 'Published', type: 'boolean', defaultValue: false },
          { name: 'publishedAt', label: 'Published Date', type: 'date' }
        ]
      },
      {
        name: 'Pages',
        slug: 'pages',
        description: 'Dynamic pages using layout blocks',
        fields: [
          { name: 'title', label: 'Page Title', type: 'text', required: true },
          { 
            name: 'layout', 
            label: 'Page Layout', 
            type: 'blocks', 
            blocksFromPlugins: [
              'ecommerceFeaturedProducts',
              'ecommerceProductSpotlight',
              'daisyHeroBanner',
              'daisyFeatureGrid',
              'starwindSplitFeature',
              'starwindMetricsBand'
            ],
            blockSettings: {
              label: 'Presentation',
              fields: [
                { name: 'className', label: 'Section Classes', type: 'text' },
                { name: 'containerClassName', label: 'Container Classes', type: 'text' },
                { name: 'dataTheme', label: 'Data Theme', type: 'text' }
              ]
            },
            blocks: [
              createSectionLayoutBlock({ componentsFromLibraries: ['daisyui'] }),
              createTwoColumnLayoutBlock({ componentsFromLibraries: ['daisyui'] }),
              createThreeColumnLayoutBlock({ componentsFromLibraries: ['daisyui'] }),
              {
                name: 'Hero Section',
                slug: 'hero',
                category: 'Marketing',
                description: 'Big headline, supporting copy, and an optional background image.',
                fields: [
                  { name: 'heading', label: 'Heading', type: 'text', required: true },
                  { name: 'subheading', label: 'Subheading', type: 'textarea' },
                  { name: 'backgroundImage', label: 'Background Image URL', type: 'text' }
                ]
              },
              {
                name: 'Feature Grid',
                slug: 'featureGrid',
                category: 'Marketing',
                description: 'Multi-column grid for product or feature highlights.',
                fields: [
                  { name: 'title', label: 'Section Title', type: 'text' },
                  { 
                    name: 'features', 
                    label: 'Features List', 
                    type: 'array',
                    fields: [
                      { name: 'title', label: 'Feature Title', type: 'text', required: true },
                      { name: 'description', label: 'Feature Description', type: 'textarea' }
                    ]
                  }
                ]
              },
              {
                name: 'Call To Action',
                slug: 'callToAction',
                category: 'Marketing',
                description: 'Compact banner with primary and secondary links.',
                fields: [
                  { name: 'eyebrow', label: 'Eyebrow', type: 'text' },
                  { name: 'title', label: 'Title', type: 'text', required: true },
                  { name: 'description', label: 'Description', type: 'textarea' },
                  { name: 'primaryLabel', label: 'Primary Button Label', type: 'text', defaultValue: 'Get started' },
                  { name: 'primaryHref', label: 'Primary Button URL', type: 'text', defaultValue: '/shop' },
                  { name: 'secondaryLabel', label: 'Secondary Button Label', type: 'text' },
                  { name: 'secondaryHref', label: 'Secondary Button URL', type: 'text' }
                ]
              },
              {
                name: 'Testimonial Quote',
                slug: 'testimonialQuote',
                category: 'Social Proof',
                description: 'Single quote block for customer or editorial proof.',
                fields: [
                  { name: 'quote', label: 'Quote', type: 'textarea', required: true },
                  { name: 'author', label: 'Author', type: 'text', required: true },
                  { name: 'role', label: 'Author Role', type: 'text' }
                ]
              },
              createCollectionRepeaterBlock({
                slug: 'featuredPosts',
                name: 'Featured Posts',
                relationTo: 'posts',
                category: 'Content',
                description: 'Curated blog stories selected from the posts collection.',
                itemLabel: 'Posts',
                ctaLabelDefault: 'View blog',
                ctaHrefDefault: '/blog',
                emptyMessageDefault: 'Select one or more posts to feature on this page.'
              })
            ]
          }
        ]
      }
    ]
  })]
});
