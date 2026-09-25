import React, { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ImageIcon, RefreshCw, Upload } from 'lucide-react';
import { Button } from '../components/ui/button';

type MediaEntry = {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes?: number | null;
  altText?: string | null;
  updatedAt?: string | number | Date | null;
};

function readMediaEntry(payload: any): MediaEntry | null {
  if (!payload) return null;
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!data || typeof data !== 'object' || !data.url) return null;

  return {
    id: payload.id ?? data.id ?? '',
    filename: data.filename ?? 'Untitled file',
    url: data.url,
    mimeType: data.mimeType ?? 'application/octet-stream',
    sizeBytes: data.sizeBytes ?? null,
    altText: data.altText ?? null,
    updatedAt: data.updatedAt ?? data.createdAt ?? null,
  };
}

function formatBytes(bytes: number | null | undefined) {
  if (!bytes || Number.isNaN(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchMediaEntries(adminBasePath: string) {
  const res = await fetch(`${adminBasePath}/api/collections/media/entries`);
  if (!res.ok) throw new Error('Failed to fetch media library');
  const payload = await res.json();
  return Array.isArray(payload)
    ? payload.map(readMediaEntry).filter((entry): entry is MediaEntry => Boolean(entry?.id))
    : [];
}

export const Route = createFileRoute('/media')({
  component: MediaLibraryRoute,
  loader: async ({ context }) => {
    const adminBasePath = context.adminBasePath || '/admin';
    return {
      adminBasePath,
      entries: await fetchMediaEntries(adminBasePath),
    };
  },
});

function MediaLibraryRoute() {
  const { adminBasePath, entries: initialEntries } = Route.useLoaderData();
  const [entries, setEntries] = useState(initialEntries);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');

  const refreshEntries = async () => {
    setIsRefreshing(true);
    setError('');

    try {
      setEntries(await fetchMediaEntries(adminBasePath));
    } catch (nextError: any) {
      setError(nextError.message || 'Failed to fetch media library');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${adminBasePath}/api/media/upload`, {
        method: 'POST',
        body: formData,
      });

      const payload = await res.json().catch(() => ({})) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(payload.error || payload.message || 'Failed to upload media');
      }

      await refreshEntries();
    } catch (nextError: any) {
      setError(nextError.message || 'Failed to upload media');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Media Library</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            Upload JPEG, PNG, GIF, WebP, or AVIF images up to 10 MiB, then reuse them across your content.
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="gap-2" onClick={() => void refreshEntries()} disabled={isRefreshing}>
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
            Refresh
          </Button>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-white/10 bg-indigo-500 px-4 py-2 text-sm font-medium text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] transition-colors hover:bg-indigo-400">
            <Upload size={14} />
            {isUploading ? 'Uploading...' : 'Upload Media'}
            <input type="file" className="hidden" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" onChange={(event) => void handleUpload(event)} />
          </label>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}

      {entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
            <ImageIcon size={22} className="text-zinc-400" />
          </div>
          <div className="mt-4 text-lg font-medium text-white">No media assets yet</div>
          <p className="mt-2 text-sm text-zinc-400">Upload the first file to start using the media picker in the editor.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => (
            <Link
              key={entry.id}
              to="/collections/$slug/$entryId"
              params={{ slug: 'media', entryId: entry.id }}
              className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/50 transition-colors hover:border-white/20 hover:bg-white/[0.03]"
            >
              {entry.mimeType.startsWith('image/') ? (
                <img src={entry.url} alt={entry.altText || entry.filename} className="h-52 w-full object-cover" />
              ) : (
                <div className="flex h-52 items-center justify-center bg-black/20 text-center text-xs uppercase tracking-[0.25em] text-zinc-500">
                  {entry.mimeType.split('/')[0] || 'File'}
                </div>
              )}
              <div className="space-y-2 p-4">
                <div className="truncate text-sm font-medium text-white">{entry.filename}</div>
                <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
                  <span>{entry.mimeType}</span>
                  {formatBytes(entry.sizeBytes) && <span>{formatBytes(entry.sizeBytes)}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
