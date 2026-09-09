import { useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, LoaderCircle, ShieldOff } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { createShare, listShares, revokeShare } from '@/lib/workspace-api';

type ShareButtonProps = { jobIds: string[]; clientId?: string; offerId?: string; label?: string; size?: 'sm' | 'xs' };

export function ShareButton(props: ShareButtonProps) {
  return <ShareLinkControl key={JSON.stringify([props.clientId, props.offerId, [...props.jobIds].sort()])} {...props} />;
}

function ShareLinkControl({ jobIds, clientId, offerId, label, size = 'sm' }: ShareButtonProps) {
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
  return <Dialog.Root>
    <Dialog.Trigger
      render={<Button size={size} variant="outline" />}
      disabled={!jobIds.length || jobIds.length > 100 || mutation.isPending}
      onClick={() => { if (!url) mutation.mutate(); }}
      title={jobIds.length > 100 ? 'Select up to 100 creatives per link' : `Share ${jobIds.length} completed creative${jobIds.length === 1 ? '' : 's'} in one public link, valid for 30 days`}
    >
      {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Link2 />} {label ?? (jobIds.length > 1 ? `Share ${jobIds.length} creatives` : 'Share creative')}
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/45" onClick={event => event.stopPropagation()} />
      <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border bg-popover p-5 text-popover-foreground shadow-xl" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation(); }}>
        <Dialog.Title className="font-semibold">Shareable link</Dialog.Title>
        <Dialog.Description className="text-sm text-muted-foreground">
          {jobIds.length} completed creative{jobIds.length === 1 ? '' : 's'} in one link. Anyone with this link can view these reviews for 30 days. Revoke it in Shared links.
        </Dialog.Description>
        {mutation.isPending ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Creating link…</p> : null}
        {url ? <div className="grid gap-2">
          <p role="status" className="flex items-center gap-1 text-sm font-medium">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}{copied ? 'Link copied' : 'Copy this link'}</p>
          <Input aria-label="Public creative link" readOnly value={url} onFocus={event => event.target.select()} />
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true)).catch(() => setCopied(false))}><Copy />Copy link</Button>
        </div> : null}
        {mutation.error ? <div className="grid gap-2"><p role="alert" className="text-sm text-destructive">{mutation.error.message}</p><Button variant="outline" onClick={() => mutation.mutate()}>Retry</Button></div> : null}
        <Dialog.Close render={<Button className="justify-self-end" variant="ghost" />}>Done</Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
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
        <Button variant={active ? "destructive" : "outline"} size="sm" disabled={!active || mutation.isPending} onClick={() => mutation.mutate(link.shareId)}><ShieldOff />{active ? 'Revoke link' : 'Inactive'}</Button>
      </div>;
    })}
    {mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
  </div>;
}
