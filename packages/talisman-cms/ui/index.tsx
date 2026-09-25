import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import './globals.css';
import { adminPath } from 'virtual:talisman-cms/config';

// Import the generated route tree
import { routeTree } from './routeTree.gen';

import type { RouterContext } from './routerContext';

const adminBasePath = adminPath || '/admin';

// Create a new router instance with base path integration
const router = createRouter({ 
  routeTree,
  basepath: adminBasePath,
  context: {
    user: null,
    adminBasePath,
    isDevAuth: false,
    isAccessAuth: false,
    isHybridAuth: false
  } as RouterContext
});

// Register the router instance for type safety
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// We wait for DOMContentLoaded injected into the Astro shell
const mountPoint = document.getElementById('talisman-root');
if (mountPoint) {
  const root = createRoot(mountPoint);
  
  // Hydrate auth state before mounting the app
  fetch(`${adminBasePath}/api/auth/session`)
    .then(res => res.json())
    .then((data: any) => {
      const user = data.user || null;
      const isDevAuth = data.isDevAuth === true;
      const isAccessAuth = data.isAccessAuth === true;
      const isHybridAuth = data.isHybridAuth === true;
      
      root.render(
        <StrictMode>
          <RouterProvider router={router} context={{ user, adminBasePath, isDevAuth, isAccessAuth, isHybridAuth }} />
        </StrictMode>
      );
    })
    .catch(err => {
      console.error('[talisman-cms] Failed to hydrate auth state:', err);
      // Mount anyways so the AuthGuard can redirect to a login view if needed
      root.render(
        <StrictMode>
          <RouterProvider router={router} context={{ user: null, adminBasePath, isDevAuth: false, isAccessAuth: false, isHybridAuth: false }} />
        </StrictMode>
      );
    });
} else {
  console.error('[talisman-cms] Mount point #talisman-root not found.');
}
