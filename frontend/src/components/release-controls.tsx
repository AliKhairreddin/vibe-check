import { useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, Send } from 'lucide-react';
import { requestJson } from '@/lib/api';
import { Button, buttonVariants } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

type Selection = {
  job_ids: string[];
  offers: { offer_id: string; offer_name: string; total: number; pending: number }[];
};
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export function ReleaseButton({ jobIds, batchId, clientId, hasReleased = false, size = 'xs' }: {
  jobIds?: string[]; batchId?: string; clientId?: string; hasReleased?: boolean; size?: 'xs' | 'sm';
}) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const targetKey = JSON.stringify([clientId, batchId, jobIds]);
  const [releasedTarget, setReleasedTarget] = useState<string | null>(null);
  const base = clientId ? `/api/client/${encodeURIComponent(clientId)}/reviews` : '/api/reviews';
  const selection = useQuery({
    queryKey: ['release-selection', clientId, batchId, jobIds],
    queryFn: () => requestJson<Selection>(`${base}/release-selection`, post(batchId ? { batch_id: batchId } : { job_ids: jobIds })),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const release = useMutation({
    mutationFn: () => requestJson<{ released: number }>(`${base}/release`, post({ job_ids: selection.data?.job_ids, offer_ids: selected, confirmed: true })),
    onSuccess: () => { setOpen(false); setReleasedTarget(targetKey); void cache.invalidateQueries(); },
  });
  const managing = hasReleased || releasedTarget === targetKey || Boolean(selection.data?.offers.some(offer => offer.pending < offer.total));
  const chosen = selection.data?.offers.filter(offer => selected.includes(offer.offer_id) && offer.pending > 0) ?? [];
  const pending = selection.data?.offers.filter(offer => offer.pending > 0) ?? [];
  return <>
    <Tooltip>
      <TooltipTrigger render={<Button
        variant="outline"
        size={size}
        aria-label={managing ? 'Manage releases' : 'Release to advertisers'}
        className={managing
          ? 'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 hover:text-purple-800 dark:border-purple-800 dark:bg-purple-950/40 dark:text-purple-300 dark:hover:bg-purple-900/50 dark:hover:text-purple-200'
          : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300 dark:hover:bg-blue-900/50 dark:hover:text-blue-200'}
        onClick={() => { setSelected([]); setConfirming(false); release.reset(); setOpen(true); }}
      />}>
        <Send aria-hidden="true" />{managing ? 'Manage' : 'Release'}
      </TooltipTrigger>
      <TooltipContent>{managing ? 'Manage releases' : 'Release to advertisers'}</TooltipContent>
    </Tooltip>
    <AlertDialog.Root open={open} onOpenChange={value => { if (!release.isPending) setOpen(value); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px]" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-4">
          <AlertDialog.Popup className="w-full max-w-lg rounded-xl bg-popover p-6 text-popover-foreground shadow-xl ring-1 ring-foreground/10">
            <div className="grid gap-5">
              <div className="grid gap-2">
                <AlertDialog.Title className="text-lg font-semibold">{confirming ? 'Are you sure you want to release?' : managing ? 'Manage releases' : 'Release to advertisers'}</AlertDialog.Title>
                <AlertDialog.Description className="text-sm leading-6 text-muted-foreground">
                  {confirming
                    ? 'The selected advertisers will be able to see these results immediately. Released creatives cannot be deleted, and a release cannot be undone. You can release to additional offers later.'
                    : managing
                      ? 'See which advertisers already have access and release to additional advertisers. Existing releases cannot be undone, and released creatives cannot be deleted.'
                      : 'Choose which advertisers can see the completed results. Unselected offers stay private. You’ll confirm the recipients before anything is released.'}
                </AlertDialog.Description>
              </div>
              {selection.isFetching && !confirming ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Checking completed results…</p> : selection.error ? <p role="alert" className="text-sm text-destructive">{selection.error.message}</p> : selection.data ? <>
                <p className="text-sm font-medium">{selection.data.job_ids.length} completed creative{selection.data.job_ids.length === 1 ? '' : 's'}</p>
                {confirming ? <ul className="grid gap-2 rounded-lg border p-4 text-sm">{chosen.map(offer => <li key={offer.offer_id} className="flex justify-between gap-4"><span>{offer.offer_name}</span><span>{offer.pending} creative{offer.pending === 1 ? '' : 's'}</span></li>)}</ul> : <div className="grid gap-3">
                  {pending.length > 1 ? <Button className="justify-self-start" variant="secondary" size="sm" onClick={() => setSelected(pending.map(offer => offer.offer_id))}>Select all unreleased offers</Button> : null}
                  {selection.data.offers.map(offer => <label key={offer.offer_id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-disabled:cursor-default">
                    <input className="size-4 accent-foreground" type="checkbox" checked={selected.includes(offer.offer_id)} disabled={!offer.pending} onChange={event => setSelected(current => event.target.checked ? [...current, offer.offer_id] : current.filter(id => id !== offer.offer_id))} />
                    <span className="flex-1 text-sm font-medium">{offer.offer_name}</span><span className="text-right text-xs text-muted-foreground">{offer.pending ? `${offer.total > offer.pending ? `${offer.total - offer.pending} released · ` : ''}${offer.pending} to release` : 'Already released'}</span>
                  </label>)}
                  {!pending.length ? <p role="status" className="text-sm text-muted-foreground">All evaluated offers have already been released.</p> : null}
                </div>}
              </> : null}
              {release.error ? <p role="alert" className="text-sm text-destructive">{release.error.message}</p> : null}
              <div className="flex flex-wrap justify-end gap-2">
                <AlertDialog.Close disabled={release.isPending} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</AlertDialog.Close>
                {confirming ? <><Button variant="outline" size="sm" disabled={release.isPending} onClick={() => setConfirming(false)}>Back</Button><Button size="sm" disabled={release.isPending || !chosen.length} onClick={() => release.mutate()}>{release.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}{release.isPending ? 'Releasing…' : 'Confirm release'}</Button></> : <Button size="sm" disabled={!chosen.length || selection.isFetching || Boolean(selection.error)} onClick={() => setConfirming(true)}>Review release</Button>}
              </div>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  </>;
}

export function DeleteSubmissionButton({ jobId, fileName, clientId }: { jobId: string; fileName: string; clientId: string }) {
  const [open, setOpen] = useState(false);
  const cache = useQueryClient();
  const remove = useMutation({
    mutationFn: () => requestJson(`/api/client/${encodeURIComponent(clientId)}/submissions/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => { setOpen(false); void cache.invalidateQueries(); },
  });
  return <><Button size="sm" variant="ghost" onClick={() => { remove.reset(); setOpen(true); }}>Remove</Button>
    <AlertDialog.Root open={open} onOpenChange={value => { if (!remove.isPending) setOpen(value); }}><AlertDialog.Portal>
      <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
      <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4"><AlertDialog.Popup className="grid w-full max-w-md gap-4 rounded-xl bg-popover p-6 text-popover-foreground shadow-xl">
        <AlertDialog.Title className="font-semibold">Remove this private creative?</AlertDialog.Title>
        <AlertDialog.Description className="break-words text-sm text-muted-foreground">{fileName} will disappear from review history. Its original source file will remain.</AlertDialog.Description>
        {remove.error ? <p role="alert" className="text-sm text-destructive">{remove.error.message}</p> : null}
        <div className="flex justify-end gap-2"><AlertDialog.Close disabled={remove.isPending} className={buttonVariants({ variant: 'outline', size: 'sm' })}>Cancel</AlertDialog.Close><Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Removing…' : 'Remove creative'}</Button></div>
      </AlertDialog.Popup></AlertDialog.Viewport>
    </AlertDialog.Portal></AlertDialog.Root>
  </>;
}
