import { handle } from '@astrojs/cloudflare/handler';
import { scheduled } from 'talisman-cms/worker';
import { TalismanPublishWorkflow } from 'talisman-cms/workflows';

export { TalismanPublishWorkflow };
export default { fetch: handle, scheduled };
