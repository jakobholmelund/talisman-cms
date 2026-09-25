import React, { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { ArrowLeft, Plus } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';

export const Route = createFileRoute('/globals/new')({
  component: NewGlobalRoute,
});

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function NewGlobalRoute() {
  const routeContext = Route.useRouteContext();
  const adminBasePath = routeContext.adminBasePath || '/admin';
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    setError('');

    try {
      const res = await fetch(`${adminBasePath}/api/globals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          description: description.trim(),
          data: {}
        }),
      });

      const result = await res.json().catch(() => ({})) as { error?: string; message?: string; slug?: string };
      if (!res.ok) {
        throw new Error(result.error || result.message || 'Failed to create global');
      }

      if (!result.slug) throw new Error('Global was created without a slug');
      window.location.assign(`${adminBasePath}/globals/${result.slug}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create global');
    } finally {
      setIsSaving(false);
    }
  }

  if (routeContext.user?.role !== 'admin') {
    return (
      <div className="space-y-3">
        <a
          href={`${adminBasePath}/globals`}
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft size={14} />
          Back to Globals
        </a>
        <p className="text-zinc-400">Admin access required to create globals.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <a
          href={`${adminBasePath}/globals`}
          className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <ArrowLeft size={14} />
          Back to Globals
        </a>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">New Global</h1>
          <p className="mt-1 text-sm text-zinc-400">Create a new singleton document. Unconfigured globals use the JSON editor until you add schema fields in config.</p>
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          <form className="space-y-5" onSubmit={handleCreate}>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-300">Name</label>
              <input
                type="text"
                value={name}
                onChange={(event) => {
                  const nextName = event.target.value;
                  setName(nextName);
                  setSlug((current) => current || slugify(nextName));
                }}
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                placeholder="Site Settings"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-300">Slug</label>
              <input
                type="text"
                value={slug}
                onChange={(event) => setSlug(slugify(event.target.value))}
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 px-3 py-2.5 text-sm font-mono shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                placeholder="site-settings"
                required
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-300">Description</label>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className="w-full rounded-md border border-white/10 bg-zinc-950/50 p-3 text-sm shadow-inner transition-all focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                placeholder="Optional context for editors"
              />
            </div>

            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            <div className="flex items-center justify-end">
              <Button type="submit" className="gap-2" disabled={isSaving}>
                <Plus size={16} />
                {isSaving ? 'Creating...' : 'Create Global'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
