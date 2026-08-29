import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileImage, LoaderCircle, Maximize2, Play, X } from 'lucide-react';

import { fetchClientReviewImage, fetchWithAdminAccess } from '@/lib/api';
import { cn } from '@/lib/utils';

type CreativeMediaKind = 'video' | 'image' | 'copy_only';

type CreativeMediaProps = {
  alt: string;
  className?: string;
  clientId?: string;
  driveUrl?: string | null;
  fileName?: string;
  jobId?: string | null;
  mediaKind?: CreativeMediaKind;
  startSeconds?: number | null;
};

export function CreativeThumbnail({
  alt,
  className,
  clientId,
  driveUrl,
  fileName,
  jobId,
  mediaKind,
}: CreativeMediaProps) {
  return (
    <CreativeMediaTrigger
      alt={alt}
      className={cn('size-12 rounded-lg', className)}
      clientId={clientId}
      driveUrl={driveUrl}
      fileName={fileName}
      jobId={jobId}
      mediaKind={mediaKind}
    />
  );
}

export function CreativeEvidenceImage({
  alt,
  className,
  clientId,
  driveUrl,
  fileName,
  filename,
  jobId,
  mediaKind,
  startSeconds,
}: CreativeMediaProps & { filename: string }) {
  return (
    <CreativeMediaTrigger
      alt={alt}
      className={cn('h-32 w-24 rounded-lg sm:h-36 sm:w-28', className)}
      clientId={clientId}
      driveUrl={driveUrl}
      fileName={fileName}
      filename={filename}
      jobId={jobId}
      mediaKind={mediaKind}
      startSeconds={startSeconds}
    />
  );
}

function CreativeMediaTrigger({
  alt,
  children,
  className,
  clientId,
  driveUrl,
  fileName,
  filename,
  jobId,
  mediaKind,
  startSeconds,
}: CreativeMediaProps & { children?: ReactNode; filename?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const canOpen = Boolean(jobId && mediaKind !== 'copy_only');
  const resolvedKind = mediaKind === 'copy_only'
    ? null
    : mediaKind ?? inferMediaKind(fileName);
  const frameClassName = cn(
    'grid shrink-0 place-items-center overflow-hidden border bg-muted/40 text-muted-foreground',
    className
  );
  const image = children ?? (
    <ProtectedCreativeImage
      alt={alt}
      clientId={clientId}
      filename={filename}
      jobId={jobId}
    />
  );

  const closePlayer = useCallback(() => {
    setIsOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  if (!canOpen || !jobId) return <span className={frameClassName}>{image}</span>;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          frameClassName,
          'group/media relative cursor-pointer outline-none transition-shadow hover:ring-2 hover:ring-primary/35 focus-visible:ring-3 focus-visible:ring-ring/60'
        )}
        aria-label={`${resolvedKind === 'image' ? 'View' : 'Play'} ${fileName || alt}`}
        title={`${resolvedKind === 'image' ? 'View' : 'Play'} in dashboard`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen(true);
        }}
      >
        {image}
        <span className="absolute inset-0 grid place-items-center bg-black/10 transition-colors group-hover/media:bg-black/25" aria-hidden="true">
          <span className="grid size-9 place-items-center rounded-full border border-white/70 bg-black/65 text-white shadow-lg transition-transform group-hover/media:scale-105">
            {resolvedKind === 'image' ? <Maximize2 className="size-4" /> : <Play className="ml-0.5 size-4 fill-current" />}
          </span>
        </span>
      </button>
      {isOpen ? (
        <CreativeMediaDialog
          alt={alt}
          clientId={clientId}
          driveUrl={driveUrl}
          fileName={fileName || alt}
          jobId={jobId}
          mediaKind={resolvedKind}
          onClose={closePlayer}
          startSeconds={startSeconds}
        />
      ) : null}
    </>
  );
}

function ProtectedCreativeImage({
  alt,
  clientId,
  filename,
  jobId,
}: {
  alt: string;
  clientId?: string;
  filename?: string;
  jobId?: string | null;
}) {
  const [protectedUrl, setProtectedUrl] = useState('');
  const [failed, setFailed] = useState(!jobId);

  useEffect(() => {
    setFailed(!jobId);
    if (!jobId) {
      setProtectedUrl('');
      return;
    }
    let active = true;
    let objectUrl = '';
    const imageRequest = clientId
      ? fetchClientReviewImage(clientId, jobId, filename)
      : fetchWithAdminAccess(
        filename
          ? `/api/reviews/${encodeURIComponent(jobId)}/frames/${encodeURIComponent(filename)}`
          : `/api/reviews/${encodeURIComponent(jobId)}/thumbnail`,
      ).then((response) => {
        if (!response.ok) throw new Error(`Image request failed with status ${response.status}.`);
        return response.blob();
      });
    void imageRequest
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setProtectedUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [clientId, filename, jobId]);

  return protectedUrl && !failed ? (
    <img
      src={protectedUrl}
      alt={alt}
      loading="lazy"
      className="size-full object-cover"
      onError={() => setFailed(true)}
    />
  ) : (
    <FileImage className="size-5" aria-hidden="true" />
  );
}

function CreativeMediaDialog({
  alt,
  clientId,
  driveUrl,
  fileName,
  jobId,
  mediaKind,
  onClose,
  startSeconds,
}: {
  alt: string;
  clientId?: string;
  driveUrl?: string | null;
  fileName: string;
  jobId: string;
  mediaKind: Exclude<CreativeMediaKind, 'copy_only'> | null;
  onClose: () => void;
  startSeconds?: number | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [resolvedKind, setResolvedKind] = useState(mediaKind);
  const [error, setError] = useState('');
  const sourceUrl = creativeMediaUrl(clientId, jobId);
  const posterUrl = creativeThumbnailUrl(clientId, jobId);
  const viewerLabel = resolvedKind === 'image'
    ? 'Image viewer'
    : resolvedKind === 'video'
      ? 'Video player'
      : 'Media viewer';
  const sourceLabel = driveUrl ? 'the linked Google Drive file' : 'the stored creative';

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  useEffect(() => {
    if (resolvedKind) return;
    const controller = new AbortController();
    void fetch(sourceUrl, { method: 'HEAD', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Media unavailable');
        const contentType = response.headers.get('content-type')?.toLowerCase() || '';
        setResolvedKind(contentType.startsWith('image/') ? 'image' : 'video');
      })
      .catch((requestError) => {
        if ((requestError as Error).name !== 'AbortError') {
          setError('This creative is not available for in-dashboard playback.');
        }
      });
    return () => controller.abort();
  }, [resolvedKind, sourceUrl]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${viewerLabel} for ${fileName}`}
        className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/15 bg-card shadow-2xl"
      >
        <header className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" title={fileName}>{fileName}</p>
            <p className="text-xs text-muted-foreground">In-dashboard {viewerLabel.toLowerCase()}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/60"
            aria-label="Close media player"
            onClick={onClose}
          >
            <X className="size-5" />
          </button>
        </header>
        <div className="grid min-h-56 flex-1 place-items-center overflow-auto bg-black sm:min-h-96">
          {error ? (
            <div className="grid max-w-md gap-3 p-8 text-center text-white">
              <FileImage className="mx-auto size-8 text-white/65" />
              <p className="text-sm font-medium">
                {resolvedKind === 'image' ? 'Image unavailable' : resolvedKind === 'video' ? 'Playback unavailable' : 'Media unavailable'}
              </p>
              <p className="text-sm leading-6 text-white/65">{error}</p>
            </div>
          ) : resolvedKind === 'video' ? (
            <video
              key={sourceUrl}
              className="max-h-[min(72vh,800px)] w-full bg-black object-contain"
              controls
              autoPlay
              playsInline
              poster={posterUrl}
              preload="metadata"
              onError={() => setError(
                driveUrl
                  ? 'The linked Google Drive video could not be streamed. Try opening the original file instead.'
                  : 'This video could not be streamed in the dashboard.'
              )}
              onLoadedMetadata={(event) => {
                if (startSeconds && Number.isFinite(startSeconds)) {
                  event.currentTarget.currentTime = startSeconds;
                }
              }}
            >
              <source src={sourceUrl} />
              Your browser does not support video playback.
            </video>
          ) : resolvedKind === 'image' ? (
            <img
              src={sourceUrl}
              alt={alt}
              className="max-h-[min(72vh,800px)] max-w-full object-contain"
              onError={() => setError(
                driveUrl
                  ? 'The linked Google Drive image could not be loaded. Try opening the original file instead.'
                  : 'This image could not be loaded in the dashboard.'
              )}
            />
          ) : (
            <div className="flex items-center gap-2 text-sm text-white/70">
              <LoaderCircle className="size-4 animate-spin" />
              Preparing media…
            </div>
          )}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
          <span>
            {resolvedKind === 'video' ? 'Streamed' : 'Loaded'} securely from {sourceLabel}.
          </span>
          {driveUrl ? (
            <a
              href={driveUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/60"
            >
              <ExternalLink className="size-3.5" />
              Open original in Drive
            </a>
          ) : null}
        </footer>
      </section>
    </div>,
    document.body
  );
}

function inferMediaKind(fileName?: string): Exclude<CreativeMediaKind, 'copy_only'> | null {
  if (!fileName) return null;
  return /\.(?:jpe?g|png|webp)$/i.test(fileName) ? 'image' : 'video';
}

function creativeMediaUrl(clientId: string | undefined, jobId: string) {
  return clientId
    ? `/api/client/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(jobId)}/media`
    : `/api/reviews/${encodeURIComponent(jobId)}/media`;
}

function creativeThumbnailUrl(clientId: string | undefined, jobId: string) {
  return clientId
    ? `/api/client/${encodeURIComponent(clientId)}/reviews/${encodeURIComponent(jobId)}/thumbnail`
    : `/api/reviews/${encodeURIComponent(jobId)}/thumbnail`;
}
