import type { APIRoute } from 'astro';
import { authAdapter } from 'virtual:talisman-cms/auth';
import { adminPath } from 'virtual:talisman-cms/config';
import { signInCloudflareAdmin } from '../../../auth/local';

export const GET: APIRoute = async ({ request }) => {
  if (authAdapter?.__talismanAuthRuntime?.moduleId !== 'talisman-cms/auth/hybrid') {
    return new Response(null, { status: 404 });
  }
  return signInCloudflareAdmin(request, adminPath);
};
