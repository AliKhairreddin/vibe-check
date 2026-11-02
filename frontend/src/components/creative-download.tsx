import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import { Button } from './ui/button';

export function CreativeDownloadButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/public/shares/${encodeURIComponent(token)}/creatives.zip`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.detail === 'string' ? body.detail : 'The download could not be completed. Please try again.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'creatives.zip';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The download could not be completed. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return <div className="grid justify-items-start gap-2">
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void download()}>{busy ? <LoaderCircle className="animate-spin" /> : <Download />}{busy ? 'Preparing ZIP…' : 'Download creatives (.ZIP)'}</Button>
    {busy ? <p role="status" className="text-xs text-muted-foreground">Preparing originals and matching text files with saved transcripts and on-screen text. Larger videos may take a few minutes.</p> : null}
    {error ? <p role="alert" className="max-w-xl text-sm text-destructive">{error}</p> : null}
  </div>;
}
