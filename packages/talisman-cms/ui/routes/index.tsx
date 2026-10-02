import React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { hasMediaCollection } from '../lib/admin-sections';

export const Route = createFileRoute('/')({ component: Index });

function Index() {
  const context = Route.useRouteContext();
  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-white">Overview</h1>
        <p className="text-zinc-400 mt-2 text-sm">Choose a workspace to manage your content.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card><CardHeader><CardTitle>Content</CardTitle></CardHeader><CardContent>
          <p className="mb-4 text-sm text-zinc-400">Open a collection to view its entries and current item count.</p>
          <Link to="/collections" className="text-indigo-300 underline">Browse collections</Link>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Media</CardTitle></CardHeader><CardContent>
          <p className="mb-4 text-sm text-zinc-400">Upload images and reuse them in your content.</p>
          {hasMediaCollection() ? <Link to="/media" className="text-indigo-300 underline">Open media library</Link> : <p className="text-sm text-zinc-400">Media is not configured for this site.</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Your account</CardTitle></CardHeader><CardContent>
          <p className="mb-4 text-sm text-zinc-400">Review your profile and sign-in settings.</p>
          {!context.isDevAuth && !context.isAccessAuth ? <Link to="/account" className="text-indigo-300 underline">Manage account</Link> : <p className="text-sm text-zinc-400">Your sign-in settings are managed by your site’s authentication provider.</p>}
        </CardContent></Card>
      </div>
    </div>
  );
}
