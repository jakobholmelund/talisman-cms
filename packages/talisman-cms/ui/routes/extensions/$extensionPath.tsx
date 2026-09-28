import React, { Suspense } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { adminExtensions } from 'virtual:talisman-cms/admin-extensions';
import { canOpenAdminExtension } from '../../lib/admin-sections';

export const Route = createFileRoute('/extensions/$extensionPath')({
  component: ExtensionRoute,
});

function ExtensionRoute() {
  const { extensionPath } = Route.useParams();
  const { context } = useRouter().options;
  const extension = adminExtensions.find((ext) => ext.path === extensionPath);

  if (!extension) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-zinc-400">
        <h2 className="text-xl font-medium text-white mb-2">Extension Not Found</h2>
        <p>The extension "{extensionPath}" could not be found or is not properly registered.</p>
      </div>
    );
  }

  if (!canOpenAdminExtension(extension, context.user)) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-zinc-400">
        <h2 className="text-xl font-medium text-white mb-2">Admin access required</h2>
        <p>{extension.label} is available to admins only.</p>
      </div>
    );
  }

  const ExtensionComponent = extension.component;

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">{extension.label}</h1>
        <p className="text-sm text-zinc-400 mt-1">Provided by {extension.plugin}</p>
      </div>
      <div className="bg-zinc-950/40 rounded-xl border border-white/5 shadow-xl overflow-hidden min-h-[400px]">
        {/* Each plugin page is its own chunk (see the admin-extensions virtual module); it loads when first opened. */}
        <Suspense fallback={<p className="p-6 text-sm text-zinc-400">Loading {extension.label}...</p>}>
          <ExtensionComponent />
        </Suspense>
      </div>
    </div>
  );
}
