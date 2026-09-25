import type { TalismanUser } from '../src/auth/types';

export interface RouterContext {
  user: TalismanUser | null;
  adminBasePath: string;
  isDevAuth: boolean;
  isAccessAuth: boolean;
}
