import { useEffect, useState } from 'react';
import { FileImage } from 'lucide-react';

import { fetchClientReviewImage } from '@/lib/api';
import { cn } from '@/lib/utils';

export function CreativeThumbnail({
  alt,
  className,
  clientId,
  jobId,
}: {
  alt: string;
  className?: string;
  clientId?: string;
  jobId?: string | null;
}) {
  return (
    <CreativeImage
      alt={alt}
      className={cn('size-12 rounded-lg', className)}
      clientId={clientId}
      jobId={jobId}
    />
  );
}

export function CreativeEvidenceImage({
  alt,
  className,
  clientId,
  filename,
  jobId,
}: {
  alt: string;
  className?: string;
  clientId?: string;
  filename: string;
  jobId: string;
}) {
  return (
    <CreativeImage
      alt={alt}
      className={cn('h-32 w-24 rounded-lg sm:h-36 sm:w-28', className)}
      clientId={clientId}
      filename={filename}
      jobId={jobId}
    />
  );
}

function CreativeImage({
  alt,
  className,
  clientId,
  filename,
  jobId,
}: {
  alt: string;
  className?: string;
  clientId?: string;
  filename?: string;
  jobId?: string | null;
}) {
  const [protectedUrl, setProtectedUrl] = useState('');
  const [failed, setFailed] = useState(!jobId);

  useEffect(() => {
    setFailed(!jobId);
    if (!clientId || !jobId) {
      setProtectedUrl('');
      return;
    }
    let active = true;
    let objectUrl = '';
    void fetchClientReviewImage(clientId, jobId, filename)
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

  const source = clientId
    ? protectedUrl
    : jobId
      ? filename
        ? `/api/reviews/${encodeURIComponent(jobId)}/frames/${encodeURIComponent(filename)}`
        : `/api/reviews/${encodeURIComponent(jobId)}/thumbnail`
      : '';

  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden border bg-muted/40 text-muted-foreground',
        className
      )}
    >
      {source && !failed ? (
        <img
          src={source}
          alt={alt}
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <FileImage className="size-5" aria-hidden="true" />
      )}
    </span>
  );
}
