import React, { useEffect, useId, useRef, useState } from 'react';
import { Upload, Images, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

type MediaLibraryEntry = {
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes?: number | null;
  altText?: string | null;
  width?: number | null;
  height?: number | null;
  createdAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
};

function readMediaRecord(payload: any): MediaLibraryEntry | null {
  if (!payload) return null;
  const source = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  if (!source || typeof source !== 'object') return null;

  return {
    id: payload.id ?? source.id ?? '',
    filename: source.filename ?? 'Untitled file',
    url: source.url ?? '',
    mimeType: source.mimeType ?? 'application/octet-stream',
    sizeBytes: source.sizeBytes ?? null,
    altText: source.altText ?? null,
    width: source.width ?? null,
    height: source.height ?? null,
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null,
  };
}

function formatBytes(bytes: number | null | undefined) {
  if (!bytes || Number.isNaN(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPreviewableImage(entry: MediaLibraryEntry | null | undefined) {
  return Boolean(entry?.url && entry.mimeType?.startsWith('image/'));
}

export function MediaFieldInput({
  adminBasePath,
  value,
  onChange,
  onBlur,
  placeholder = 'Select a media asset or paste a URL',
}: {
  adminBasePath: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [libraryItems, setLibraryItems] = useState<MediaLibraryEntry[]>([]);

  const refreshLibrary = async () => {
    setIsLoadingLibrary(true);
    setLibraryError('');

    try {
      const res = await fetch(`${adminBasePath}/api/collections/media/entries`);
      if (!res.ok) {
        throw new Error('Failed to load media library');
      }

      const payload = await res.json();
      const nextItems = Array.isArray(payload)
        ? payload.map(readMediaRecord).filter((item): item is MediaLibraryEntry => Boolean(item?.id && item.url))
        : [];

      setLibraryItems(nextItems);
    } catch (error: any) {
      setLibraryError(error.message || 'Failed to load media library');
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  useEffect(() => {
    if (!isLibraryOpen || libraryItems.length > 0 || isLoadingLibrary) return;
    void refreshLibrary();
  }, [isLibraryOpen, libraryItems.length, isLoadingLibrary]);

  const handleUpload = async (file: File | null) => {
    if (!file) return;

    setIsUploading(true);
    setLibraryError('');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${adminBasePath}/api/media/upload`, {
        method: 'POST',
        body: formData,
      });

      const payload = await res.json().catch(() => ({})) as { error?: string; message?: string; url?: string };
      if (!res.ok) {
        throw new Error(payload.error || payload.message || 'Failed to upload media');
      }

      const uploaded = readMediaRecord(payload);
      if (!uploaded?.url) {
        throw new Error('Upload completed without a usable media URL');
      }

      onChange(uploaded.url);
      setIsLibraryOpen(true);
      await refreshLibrary();
    } catch (error: any) {
      setLibraryError(error.message || 'Failed to upload media');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const currentSelection = libraryItems.find((item) => item.url === value) || null;
  const hasValue = Boolean(value.trim());

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 md:flex-row">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          className="w-full bg-zinc-950/50 border border-white/10 rounded-md px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all shadow-inner"
        />
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            id={fileInputId}
            type="file"
            className="hidden"
            accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
            onChange={(event) => void handleUpload(event.target.files?.[0] ?? null)}
          />
          <Button type="button" variant="outline" className="gap-2" disabled={isUploading} onClick={() => fileInputRef.current?.click()}>
            {isUploading ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
            {isUploading ? 'Uploading...' : 'Upload'}
          </Button>
          <Button type="button" variant="outline" className="gap-2" onClick={() => setIsLibraryOpen((current) => !current)}>
            <Images size={14} />
            {isLibraryOpen ? 'Hide Library' : 'Browse'}
          </Button>
        </div>
      </div>

      {libraryError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {libraryError}
        </div>
      )}

      {hasValue && (
        <div className="overflow-hidden rounded-lg border border-white/10 bg-black/30">
          {isPreviewableImage(currentSelection) || value.startsWith('http') || value.startsWith('/') || value.startsWith('data:') ? (
            <img src={value} alt={currentSelection?.altText || currentSelection?.filename || 'Selected media'} className="h-40 w-full object-cover" />
          ) : (
            <div className="flex h-24 items-center justify-between gap-3 px-4">
              <div>
                <div className="text-sm font-medium text-white">{currentSelection?.filename || 'Selected media URL'}</div>
                <div className="mt-1 text-xs text-zinc-400 break-all">{value}</div>
              </div>
            </div>
          )}
          {currentSelection && (
            <div className="flex flex-wrap items-center gap-3 border-t border-white/10 px-4 py-3 text-xs text-zinc-400">
              <span>{currentSelection.filename}</span>
              {currentSelection.mimeType && <span>{currentSelection.mimeType}</span>}
              {formatBytes(currentSelection.sizeBytes) && <span>{formatBytes(currentSelection.sizeBytes)}</span>}
            </div>
          )}
        </div>
      )}

      {isLibraryOpen && (
        <div className="rounded-xl border border-white/10 bg-zinc-950/40 p-4 space-y-4 shadow-inner">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-zinc-100">Media Library</div>
              <div className="mt-1 text-xs text-zinc-400">Select an uploaded asset to write its URL into this field.</div>
            </div>
            <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void refreshLibrary()} disabled={isLoadingLibrary}>
              <RefreshCw size={14} className={isLoadingLibrary ? 'animate-spin' : ''} />
              Refresh
            </Button>
          </div>

          {isLoadingLibrary ? (
            <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-6 text-sm text-zinc-400">
              Loading media assets...
            </div>
          ) : libraryItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-3 py-6 text-sm text-zinc-500">
              No media assets yet. Upload the first file from here.
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {libraryItems.map((item) => {
                const isSelected = item.url === value;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChange(item.url)}
                    className={`overflow-hidden rounded-xl border text-left transition-colors ${
                      isSelected
                        ? 'border-indigo-400/50 bg-indigo-500/10'
                        : 'border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/[0.04]'
                    }`}
                  >
                    {isPreviewableImage(item) ? (
                      <img src={item.url} alt={item.altText || item.filename} className="h-36 w-full object-cover" />
                    ) : (
                      <div className="flex h-36 items-center justify-center bg-zinc-900 text-center text-xs uppercase tracking-[0.2em] text-zinc-500">
                        {item.mimeType.split('/')[0] || 'File'}
                      </div>
                    )}
                    <div className="space-y-1 px-3 py-3">
                      <div className="truncate text-sm font-medium text-white">{item.filename}</div>
                      <div className="text-xs text-zinc-400">{item.mimeType}</div>
                      {formatBytes(item.sizeBytes) && <div className="text-xs text-zinc-500">{formatBytes(item.sizeBytes)}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
