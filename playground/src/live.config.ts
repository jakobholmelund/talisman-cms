import { defineLiveCollection } from 'astro:content';
import { z } from 'astro/zod';
import { talismanLiveLoader } from 'talisman-cms/loader';

const pages = defineLiveCollection({
  loader: talismanLiveLoader({ collection: 'pages' }),
  schema: z.object({
    id: z.string(),
    data: z.object({
      title: z.string(),
      layout: z.any().optional(), // We'll keep it as any for now
    })
  })
});

const posts = defineLiveCollection({
  loader: talismanLiveLoader({ collection: 'posts' })
});

export const collections = { pages, posts };
