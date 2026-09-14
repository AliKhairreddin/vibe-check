import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, LoaderCircle, Mail, X } from 'lucide-react';
import { requestJson } from '@/lib/api';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Select } from './ui/select';

type Batch = { batchId: string; title: string; label: string; count: number; createdAt: number };
type Email = {
  emailId: string; offerId: string; to: string[]; cc: string[]; replyTo: string; subject: string; message: string; signature: string;
  status: 'draft' | 'sending' | 'sent' | 'uncertain'; createdAt: number; expiresAt: number; sentAt?: number; from?: string;
  links: { batchId: string; label: string; url: string; jobIds: string[] }[];
};
type Options = { advertisers: { id: string; name: string }[]; sender: string; sending_enabled: boolean };
type Props = { clientId?: string; initialBatchId?: string; initialOfferId?: string };
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const addresses = (value: string) => [...new Set(value.split(/[,;\n]+/).map(item => item.trim().toLowerCase()).filter(Boolean))];
const date = (value: number) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function EmailBatchesButton({ size = 'sm', ...props }: Props & { size?: 'xs' | 'sm' }) {
  const [open, setOpen] = useState(false);
  return <><Button variant="outline" size={size} onClick={() => setOpen(true)}><Mail />Send email</Button><ReleaseEmailDialog {...props} open={open} onOpenChange={setOpen} /></>;
}

export function ReleaseEmailDialog({ open, onOpenChange, ...props }: Props & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[1px]" />
      <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-3 sm:p-6">
        <Dialog.Popup className="relative my-auto grid w-full min-w-0 max-w-2xl gap-5 rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl sm:p-6">
          <div className="pr-8"><Dialog.Title className="flex items-center gap-2 text-lg font-semibold"><Mail className="size-5" />Send released batches</Dialog.Title><Dialog.Description className="mt-1 text-sm leading-6 text-muted-foreground">Combine Auto, Home, or other released batches in one email to an advertiser.</Dialog.Description></div>
          <Dialog.Close disabled={busy} render={<Button variant="ghost" size="sm" className="absolute top-3 right-3" aria-label="Close email composer" />}><X /></Dialog.Close>
          {open ? <EmailSetup {...props} setBusy={setBusy} close={() => onOpenChange(false)} /> : null}
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>;
}

function EmailSetup({ clientId, initialBatchId, initialOfferId, setBusy, close }: Props & { setBusy: (busy: boolean) => void; close: () => void }) {
  const base = clientId ? `/api/client/${encodeURIComponent(clientId)}/release-emails` : '/api/release-emails';
  const options = useQuery({ queryKey: ['release-email-options', clientId], queryFn: () => requestJson<Options>(`${base}/options`) });
  const [selectedOffer, setSelectedOffer] = useState(initialOfferId ?? clientId ?? '');
  const offerId = selectedOffer || options.data?.advertisers[0]?.id || '';
  const [locked, setLocked] = useState(false);
  if (options.isPending) return <p role="status" className="text-sm">Loading email options…</p>;
  if (options.error) return <p role="alert" className="text-sm text-destructive">{options.error.message}</p>;
  return <>
    <label className="grid min-w-0 gap-1.5 text-sm font-medium">Advertiser<Select aria-label="Email advertiser" disabled={locked} value={offerId} onValueChange={setSelectedOffer} options={options.data.advertisers.map(offer => ({ value: offer.id, label: offer.name }))} /></label>
    <ComposerLoader key={offerId} base={base} offerId={offerId} initialBatchId={initialBatchId} options={options.data} setBusy={value => { setBusy(value); setLocked(value); }} setLocked={setLocked} close={close} />
  </>;
}

type ComposerProps = { base: string; offerId: string; initialBatchId?: string; options: Options; setBusy: (busy: boolean) => void; setLocked: (locked: boolean) => void; close: () => void };
function ComposerLoader(props: ComposerProps) {
  const recent = useQuery({ queryKey: ['release-emails', props.base, props.offerId], queryFn: () => requestJson<Email[]>(`${props.base}/recent?offer_id=${encodeURIComponent(props.offerId)}`) });
  if (recent.isPending) return <p role="status" className="text-sm">Loading recent emails…</p>;
  if (recent.error) return <p role="alert" className="text-sm text-destructive">{recent.error.message}</p>;
  return <Composer {...props} recent={recent.data} />;
}

function Composer({ base, offerId, initialBatchId, options, setBusy, setLocked, close, recent }: ComposerProps & { recent: Email[] }) {
  const cache = useQueryClient();
  const lastSent = recent.find(email => email.status === 'sent');
  const [to, setTo] = useState(lastSent?.to.join(', ') ?? '');
  const [cc, setCc] = useState(lastSent?.cc.join(', ') ?? '');
  const [replyTo, setReplyTo] = useState(lastSent?.replyTo ?? '');
  const [subject, setSubject] = useState(`Creatives for approval — ${date(Date.now())}`);
  const [message, setMessage] = useState('Dear Team,\n\nPlease find the creative batches below for your review and approval.');
  const [signature, setSignature] = useState(lastSent?.signature ?? 'Regards,\nCreative Team');
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Email | null>(null);
  const [sendResult, setSendResult] = useState<{ status: Email['status']; audit_pending?: boolean } | null>(null);
  const requestId = useRef<string | null>(null);
  const initialSelected = useRef(false);
  const batches = useInfiniteQuery({
    queryKey: ['email-batches', base, offerId, initialBatchId], initialPageParam: '',
    queryFn: ({ pageParam }) => requestJson<{ batches: Batch[]; cursor: string; isDone: boolean }>(`${base}/batches?${new URLSearchParams({ offer_id: offerId, ...(pageParam ? { cursor: pageParam } : {}), ...(initialBatchId ? { initial_batch_id: initialBatchId } : {}) })}`),
    getNextPageParam: page => page.isDone ? undefined : page.cursor,
  });
  const available = [...new Map(batches.data?.pages.flatMap(page => page.batches).map(batch => [batch.batchId, batch])).values()];
  useEffect(() => {
    const batch = batches.data?.pages[0]?.batches.find(item => item.batchId === initialBatchId);
    if (batch && !initialSelected.current) { initialSelected.current = true; setSelected({ [batch.batchId]: batch.label }); }
  }, [batches.data, initialBatchId]);
  const prepare = useMutation({
    mutationFn: () => {
      requestId.current ??= crypto.randomUUID().replace(/-/g, '');
      return requestJson<Email>(`${base}/preview`, post({ email_id: requestId.current, offer_id: offerId, to: addresses(to), cc: addresses(cc), reply_to: replyTo.trim(), subject, message, signature,
        batches: Object.entries(selected).map(([batch_id, label]) => ({ batch_id, label })) }));
    },
    onMutate: () => setBusy(true),
    onSuccess: email => { setDraft(email); void cache.invalidateQueries({ queryKey: ['shares'] }); },
    onSettled: () => setBusy(false),
  });
  const send = useMutation({
    mutationFn: () => requestJson<{ status: Email['status']; audit_pending?: boolean }>(`${base}/${draft!.emailId}/send`, post({ confirmed: true })),
    onMutate: () => setBusy(true),
    onSuccess: result => { setSendResult(result); void cache.invalidateQueries({ queryKey: ['release-emails'] }); },
    onSettled: () => setBusy(false),
  });
  useEffect(() => { setLocked(Boolean(draft) || prepare.isPending || send.isPending); }, [draft, prepare.isPending, send.isPending, setLocked]);
  const status = sendResult?.status;
  if (status) return <div className="grid gap-4">
    <div role="status" className="rounded-lg border bg-muted/30 p-4"><p className="flex items-center gap-2 font-medium">{status === 'sent' ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Mail className="size-5" />}{status === 'sent' ? 'Email sent' : status === 'sending' ? 'Email is being sent' : 'Delivery needs checking'}</p><p className="mt-2 text-sm leading-6 text-muted-foreground">{status === 'sent' ? `Submitted to the email provider for ${draft?.to.join(', ')} with ${draft?.links.length} batch links.` : 'This email has already had a send attempt. Check with the recipient or ask an administrator to inspect delivery before creating another email.'}{sendResult.audit_pending ? ' The delivery record is still awaiting an update.' : ''}</p></div>
    <Button className="justify-self-end" onClick={close}>Done</Button>
  </div>;
  if (draft) return <div className="grid min-w-0 gap-4">
    <div className="grid gap-2 rounded-lg border bg-muted/20 p-4 text-sm [overflow-wrap:anywhere]">
      <p><span className="font-medium">From:</span> Adchecked &lt;{options.sender || 'Sender not configured'}&gt;</p>
      <p><span className="font-medium">To:</span> {draft.to.join(', ')}</p>
      {draft.cc.length ? <p><span className="font-medium">CC:</span> {draft.cc.join(', ')}</p> : null}
      <p><span className="font-medium">Reply to:</span> {draft.replyTo}</p>
      <p><span className="font-medium">Subject:</span> {draft.subject}</p>
    </div>
    <div className="grid min-w-0 gap-5 rounded-lg border bg-background p-4 text-sm leading-6 sm:p-5">
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.message}</p>
      <div className="grid gap-3">{draft.links.map(link => <a key={link.batchId} href={link.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-start gap-2 text-primary underline underline-offset-4"><span className="min-w-0 [overflow-wrap:anywhere]">{link.label} Link <span className="text-muted-foreground">({link.jobIds.length} creatives)</span></span><ExternalLink className="mt-1 size-3.5 shrink-0" /></a>)}</div>
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{draft.signature}</p>
      <p className="text-xs leading-5 text-muted-foreground">These review links are valid for 30 days. Anyone with a link can view the selected advertiser’s results.</p>
    </div>
    <p className="text-xs text-muted-foreground">Links expire {date(draft.expiresAt)}. You can revoke them in Shared links.</p>
    {!options.sending_enabled ? <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Email sending needs to be configured before you can send.</p> : null}
    {send.error ? <p role="alert" className="text-sm text-destructive">{send.error.message} You can check again safely; the same email will not be sent twice.</p> : null}
    <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={send.isPending || Boolean(send.error)} onClick={() => { setDraft(null); requestId.current = null; }}>Edit email</Button><Button disabled={!options.sending_enabled || send.isPending} onClick={() => send.mutate()}>{send.isPending ? <LoaderCircle className="animate-spin" /> : <Mail />}{send.isPending ? 'Sending…' : send.error ? 'Check send status' : 'Send email'}</Button></div>
  </div>;

  const visible = available.filter(batch => `${batch.title} ${batch.label} ${date(batch.createdAt)}`.toLowerCase().includes(search.toLowerCase()));
  const count = Object.keys(selected).length;
  return <form className="grid min-w-0 gap-5" onChange={() => { requestId.current = null; }} onSubmit={event => { event.preventDefault(); prepare.mutate(); }}>
    <fieldset disabled={prepare.isPending} className="grid min-w-0 gap-5">
      <div className="grid gap-2"><div className="flex flex-wrap justify-between gap-2"><p className="text-sm font-medium">Released batches <span className="font-normal text-muted-foreground">({count}/10 selected)</span></p></div>
        <Input aria-label="Search released batches" type="search" placeholder="Find a batch by name, date, Auto or Home" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="max-h-56 overflow-y-auto rounded-lg border">
          {batches.isPending ? <p role="status" className="p-4 text-sm">Finding released batches…</p> : null}
          {visible.map(batch => <div key={batch.batchId} className="grid gap-2 border-b p-3 last:border-b-0"><label className="flex min-w-0 cursor-pointer items-start gap-3"><Checkbox className="mt-1 size-4 shrink-0" checked={batch.batchId in selected} disabled={count >= 10 && !(batch.batchId in selected)} onChange={event => { requestId.current = null; setSelected(current => { const next = { ...current }; if (event.target.checked) next[batch.batchId] = batch.label; else delete next[batch.batchId]; return next; }); }} /><span className="min-w-0"><span className="block break-words text-sm font-medium">{batch.title}</span><span className="block text-xs leading-5 text-muted-foreground">{batch.label} · {date(batch.createdAt)} · {batch.count} creatives</span></span></label>{batch.batchId in selected ? <label className="ml-7 grid gap-1 text-xs text-muted-foreground">Link label<Input aria-label={`Link label for ${batch.title}`} value={selected[batch.batchId]} maxLength={120} required onChange={event => setSelected(current => ({ ...current, [batch.batchId]: event.target.value }))} /></label> : null}</div>)}
          {!batches.isPending && !visible.length ? <p className="p-4 text-sm text-muted-foreground">No matching released batches in the loaded results. Release the advertiser’s completed creatives first, or load older batches.</p> : null}
        </div>
        {batches.hasNextPage ? <Button type="button" variant="ghost" size="sm" className="justify-self-start" disabled={batches.isFetchingNextPage} onClick={() => void batches.fetchNextPage()}>{batches.isFetchingNextPage ? 'Loading…' : 'Load older batches'}</Button> : null}
        {batches.error ? <p role="alert" className="text-sm text-destructive">{batches.error.message}</p> : null}
        <p className="text-xs leading-5 text-muted-foreground">Only batches released to this advertiser are included. Private and other advertisers’ results stay out of the email.</p>
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">To<Textarea aria-label="Email recipients" placeholder="name@company.com, colleague@company.com" rows={2} required value={to} onChange={event => setTo(event.target.value)} /></label>
        <label className="grid min-w-0 gap-1.5 text-sm font-medium">CC <span className="sr-only">(optional)</span><Textarea aria-label="Email CC" placeholder="Optional CC addresses" rows={2} value={cc} onChange={event => setCc(event.target.value)} /></label>
      </div>
      {lastSent ? <p className="-mt-3 text-xs text-muted-foreground">Recipients and reply-to filled from your last sent email to this advertiser.</p> : null}
      <div className="grid min-w-0 gap-4 sm:grid-cols-2"><label className="grid min-w-0 gap-1.5 text-sm font-medium">From<Input aria-label="Email sender" readOnly value={options.sender || 'Not configured'} /></label><label className="grid min-w-0 gap-1.5 text-sm font-medium">Reply to<Input aria-label="Reply-to address" type="email" placeholder="Your team’s email address" required maxLength={254} value={replyTo} onChange={event => setReplyTo(event.target.value)} /></label></div>
      <label className="grid gap-1.5 text-sm font-medium">Subject<Input aria-label="Email subject" required maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} /></label>
      <label className="grid gap-1.5 text-sm font-medium">Message<Textarea aria-label="Email message" rows={4} required maxLength={10000} value={message} onChange={event => setMessage(event.target.value)} /><span className="text-xs font-normal text-muted-foreground">The labeled batch links will appear below your message.</span></label>
      <label className="grid gap-1.5 text-sm font-medium">Signature<Textarea aria-label="Email signature" rows={2} maxLength={1000} value={signature} onChange={event => setSignature(event.target.value)} /></label>
    </fieldset>
    {prepare.error ? <p role="alert" className="text-sm text-destructive">{prepare.error.message}</p> : null}
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Preview the recipients and links before sending.</p><Button type="submit" disabled={!count || prepare.isPending || Object.values(selected).some(label => !label.trim())}>{prepare.isPending ? <LoaderCircle className="animate-spin" /> : <Mail />}{prepare.isPending ? 'Preparing…' : 'Preview email'}</Button></div>
    {recent.length ? <details className="border-t pt-4 text-sm"><summary className="cursor-pointer font-medium">Recent emails</summary><div className="mt-3 grid gap-3">{recent.map(email => <div key={email.emailId} className="min-w-0 rounded-lg border p-3"><p className="break-words font-medium">{email.subject}</p><p className="mt-1 break-words text-xs text-muted-foreground">{date(email.sentAt ?? email.createdAt)} · {email.links.length} batches · {email.to.join(', ')}</p><p className="mt-1 text-xs">{email.status === 'sent' ? 'Sent' : email.status === 'draft' ? 'Preview only — not sent' : 'Send attempted — check delivery before resending'}</p></div>)}</div></details> : null}
  </form>;
}
