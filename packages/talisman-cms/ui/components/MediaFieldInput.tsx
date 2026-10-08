import React, { useEffect, useId, useRef, useState } from 'react';
import { Upload, Images, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';
import { MediaFilters } from './MediaFilters';
import { useMediaResults } from '../lib/use-media-results';

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

async function readErrorResponse(res: Response, fallback: string) {
  const payload = await res.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  const message = [payload?.error, payload?.message].find((candidate) => typeof candidate === 'string' && candidate.trim());
  return typeof message === 'string' ? message : `${fallback} (HTTP ${res.status})`;
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

// The picker shows the newest uploads first, one page at a time, instead of the whole library.
const LIBRARY_PAGE_SIZE = 48;

function readLibraryItems(docs: unknown) {
  return Array.isArray(docs)
    ? docs.map(readMediaRecord).filter((item): item is MediaLibraryEntry => Boolean(item?.id && item.url))
    : [];
}

export function MediaFieldInput({
  adminBasePath,
  value,
  onChange,
  onBlur,
  placeholder = 'Select a media asset or paste a URL',
  inputId,
  describedBy,
  invalid,
  required,
  label,
}: {
  adminBasePath: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** The URL input's id, so the field's label names it. */
  inputId?: string;
  describedBy?: string;
  invalid?: boolean;
  required?: boolean;
  /** The field's label, which tells the Upload, Browse and Refresh buttons of one field from another's. */
  label?: string;
}) {
  const fileInputId = useId();
  const libraryPanelId = useId();
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const results = useMediaResults(adminBasePath, LIBRARY_PAGE_SIZE);
  const isLoadingLibrary = results.busy === 'refresh';
  const isLoadingMore = results.busy === 'more';
  const libraryItems = readLibraryItems(results.page.docs);
  const libraryCursor = results.page.nextCursor;
  const [selectedAsset, setSelectedAsset] = useState<MediaLibraryEntry | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  // Read out by screen readers: an upload otherwise only changes the button text and the URL value.
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState('');
  const libraryError = uploadError || results.error;
  // Opening Browse loads the library once; later loads come from Refresh or an upload, so an
  // empty or failed response cannot trigger another request by itself.
  const libraryRequestedRef = useRef(false);

  const refreshLibrary = () => { if (!results.busy) { setUploadError(''); return results.refresh(); } };
  const loadMoreLibrary = async () => { if (await results.loadMore()) summaryRef.current?.focus(); };

  useEffect(() => {
    if (!isLibraryOpen || libraryRequestedRef.current) return;
    libraryRequestedRef.current = true;
    void refreshLibrary();
  }, [isLibraryOpen]);

  const handleUpload = async (file: File | null) => {
    if (!file || isUploading) return;

    setIsUploading(true);
    setUploadError('');
    setUploadStatus(`Uploading ${file.name}…`);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${adminBasePath}/api/media/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        throw new Error(await readErrorResponse(res, 'Failed to upload media'));
      }

      const uploaded = readMediaRecord(await res.json().catch(() => ({})));
      if (!uploaded?.url) {
        throw new Error('Upload completed without a usable media URL');
      }

      setSelectedAsset(uploaded);
      onChange(uploaded.url);
      libraryRequestedRef.current = true;
      setIsLibraryOpen(true);
      await results.refresh();
      setUploadStatus(`Uploaded ${file.name}; URL set.`);
    } catch (error: any) {
      setUploadStatus('');
      setUploadError(error.message || 'Failed to upload media');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const visibleSelection = libraryItems.find(item => item.url === value);
  const currentSelection = visibleSelection || (selectedAsset?.url === value ? selectedAsset : null);
  useEffect(() => { if (visibleSelection) setSelectedAsset(visibleSelection); }, [results.page.docs, value]);
  const filtered = Boolean(results.search.q || results.search.type);
  const hasValue = Boolean(value.trim());

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 md:flex-row">
        <input
          id={inputId}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-required={required || undefined}
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
          {/* Stays focusable while the upload runs; the status line below says what is happening. */}
          <Button type="button" variant="outline" className="gap-2" aria-disabled={isUploading || undefined} aria-busy={isUploading || undefined} onClick={() => { if (!isUploading) fileInputRef.current?.click(); }}>
            {isUploading ? <LoaderCircle size={14} className="animate-spin" /> : <Upload size={14} />}
            {isUploading ? 'Uploading...' : 'Upload'}
            {label && <span className="sr-only"> for {label}</span>}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="gap-2"
            aria-expanded={isLibraryOpen}
            aria-controls={isLibraryOpen ? libraryPanelId : undefined}
            onClick={() => setIsLibraryOpen((current) => !current)}
          >
            <Images size={14} />
            {isLibraryOpen ? 'Hide Library' : 'Browse'}
            {label && <span className="sr-only"> for {label}</span>}
          </Button>
        </div>
      </div>

      <p role="status" className="sr-only">{uploadStatus}</p>
      {libraryError && (
        <div role="alert" className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {libraryError} Your selected URL is kept.
          <Button type="button" variant="outline" size="sm" className="ml-3" aria-disabled={Boolean(results.busy) || undefined} onClick={async () => { if (await refreshLibrary()) summaryRef.current?.focus(); }}>Retry media</Button>
        </div>
      )}

      {hasValue && (
        <div className="overflow-hidden rounded-lg border border-white/10 bg-black/30">
          {(currentSelection ? isPreviewableImage(currentSelection) : value.startsWith('http') || value.startsWith('/') || value.startsWith('data:')) ? (
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
        <div id={libraryPanelId} role="region" aria-label="Media library" className="rounded-xl border border-white/10 bg-zinc-950/40 p-4 space-y-4 shadow-inner">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-zinc-100">Media Library</div>
              <div className="mt-1 text-xs text-zinc-400">Select an uploaded asset to write its URL into this field.</div>
            </div>
            <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void refreshLibrary()} aria-disabled={isLoadingLibrary || isLoadingMore || undefined} aria-busy={isLoadingLibrary || undefined}>
              <RefreshCw size={14} className={isLoadingLibrary ? 'animate-spin' : ''} />
              Refresh
              {label && <span className="sr-only"> the media library for {label}</span>}
            </Button>
          </div>

          <MediaFilters search={results.search} busy={Boolean(results.busy)} onApply={search => { setUploadError(''); void results.refresh(search); }} />
          <p ref={summaryRef} tabIndex={-1} role="status" className="text-xs text-zinc-400 focus:outline-none">{isLoadingLibrary ? 'Loading media assets…' : isLoadingMore ? 'Loading more media…' : results.error ? 'Media assets could not be loaded.' : `${libraryItems.length} media assets shown`}</p>
          {isLoadingLibrary && libraryItems.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-6 text-sm text-zinc-400">
              Loading media assets...
            </div>
          ) : !results.error && libraryItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 bg-black/20 px-3 py-6 text-sm text-zinc-500">
              {filtered ? 'No media assets match these filters. Try another filename or file type.' : 'No media assets yet. Upload the first file from here.'}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {libraryItems.map((item) => {
                const isSelected = item.url === value;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => { setSelectedAsset(item); onChange(item.url); }}
                    className={`overflow-hidden rounded-xl border text-left transition-colors ${
                      isSelected
                        ? 'border-indigo-400/50 bg-indigo-500/10'
                        : 'border-white/10 bg-black/20 hover:border-white/20 hover:bg-white/[0.04]'
                    }`}
                  >
                    {isPreviewableImage(item) ? (
                      // The filename is printed below the image, so it is not repeated as the alt text.
                      <img src={item.url} alt={item.altText || ''} className="h-36 w-full object-cover" />
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

          {libraryCursor && (
            <div className="flex justify-center">
              <Button type="button" variant="outline" size="sm" aria-disabled={isLoadingMore || isLoadingLibrary || undefined} aria-busy={isLoadingMore || undefined} onClick={() => void loadMoreLibrary()}>
                {isLoadingMore ? 'Loading...' : 'Load more media'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
