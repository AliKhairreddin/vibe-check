import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, LoaderCircle, ShieldOff } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { createShare, listShares, revokeShare } from '@/lib/workspace-api';

export function ShareButton({ jobIds, clientId, offerId }: { jobIds: string[]; clientId?: string; offerId?: string }) {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const cache = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => createShare(jobIds, clientId, offerId),
    onSuccess: async result => {
      setUrl(result.url);
      void cache.invalidateQueries({ queryKey: ['shares'] });
      try { await navigator.clipboard.writeText(result.url); setCopied(true); } catch { setCopied(false); }
    },
  });
  return <div className="grid gap-2">
    <Button size="sm" variant="outline" disabled={!jobIds.length || mutation.isPending} onClick={() => { setUrl(''); setCopied(false); mutation.mutate(); }} title="Create a public link, valid for 30 days">
      {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Link2 />} {jobIds.length > 1 ? `Share ${jobIds.length} creatives` : 'Copy public link'}
    </Button>
    {url ? <div className="grid max-w-sm gap-1 rounded-lg border bg-background p-2 text-xs" role="status">
      <span className="flex items-center gap-1 font-medium">{copied ? <Check className="size-3" /> : <Copy className="size-3" />}{copied ? 'Link copied' : 'Copy this link'}</span>
      <Input aria-label="Public creative link" className="h-8 text-xs" readOnly value={url} onFocus={event => event.target.select()} />
      <span className="text-muted-foreground">Anyone with this link can view these reviews for 30 days. Revoke it in Shared links.</span>
    </div> : null}
    {mutation.error ? <p role="alert" className="max-w-sm text-xs text-destructive">{mutation.error.message}</p> : null}
  </div>;
}

export function SharedLinksPanel({ clientId }: { clientId?: string }) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['shares', clientId ?? 'admin'], queryFn: () => listShares(clientId) });
  const mutation = useMutation({ mutationFn: (id: string) => revokeShare(id, clientId), onSuccess: () => { void cache.invalidateQueries({ queryKey: ['shares'] }); } });
  return <div className="grid gap-4">
    <div><h1 className="text-2xl font-semibold tracking-tight">Shared links</h1><p className="mt-1 text-sm text-muted-foreground">Public links show live review results. Revoking a link immediately ends access. Most recent 100 links.</p></div>
    {query.isLoading ? <p>Loading shared links…</p> : query.error ? <p role="alert" className="text-destructive">{query.error.message}</p> : !query.data?.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No shared links yet. Open a creative or select several creatives to share.</div> : query.data.map(link => {
      const active = !link.revokedAt && link.expiresAt > Date.now();
      return <div key={link.shareId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div><p className="font-medium">{link.title}</p><p className="mt-1 text-xs text-muted-foreground">{link.count} creatives · {link.revokedAt ? 'Revoked' : active ? 'Expires' : 'Expired'} {new Date(link.revokedAt ?? link.expiresAt).toLocaleDateString()}</p></div>
        <Button variant="outline" size="sm" disabled={!active || mutation.isPending} onClick={() => mutation.mutate(link.shareId)}><ShieldOff />{active ? 'Revoke link' : 'Inactive'}</Button>
      </div>;
    })}
    {mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
  </div>;
}
