import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, FileUp, LoaderCircle, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { ClientPortalFrame, useClientAuth } from './client-dashboard';
import { useWorkspace } from './workspace-context';
import { Button, buttonVariants } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import { Badge } from './ui/badge';
import { getWorkspaceGuidelines, saveWorkspaceGuidelines } from '@/lib/workspace-api';
import { isDemo } from '@/lib/demo';
import type { OfferOverride, OfferProfile } from '@/lib/api';

function PolicyForm({ clientId, initial }: { clientId: string; initial: OfferProfile }) {
  const [saved, setSaved] = useState(initial);
  const [guidelines, setGuidelines] = useState(initial.official_guidelines);
  const [rules, setRules] = useState(initial.internal_overrides);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [fileError, setFileError] = useState('');
  const cache = useQueryClient();
  const maxLength = isDemo() ? 12_000 : 200_000;
  const maxRules = isDemo() ? 10 : 100;
  const dirty = guidelines !== saved.official_guidelines || enabled !== saved.enabled
    || JSON.stringify(rules) !== JSON.stringify(saved.internal_overrides);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function adopt(profile: OfferProfile) {
    setSaved(profile); setGuidelines(profile.official_guidelines); setRules(profile.internal_overrides); setEnabled(profile.enabled);
    cache.setQueryData(['workspace-guidelines', clientId], profile);
  }
  const save = useMutation({
    mutationFn: () => saveWorkspaceGuidelines(clientId, {
      official_guidelines: guidelines.trim(), internal_overrides: rules,
      enabled, expected_version: saved.version,
    }),
    onSuccess: adopt,
  });
  const reload = useMutation({ mutationFn: () => getWorkspaceGuidelines(clientId), onSuccess: profile => { adopt(profile); save.reset(); setFileError(''); } });
  function changed() { save.reset(); setFileError(''); }
  function updateRule(id: string, patch: Partial<OfferOverride>) {
    changed(); setRules(current => current.map(rule => rule.override_id === id ? { ...rule, ...patch } : rule));
  }
  function updateGuidelines(value: string) {
    changed(); setGuidelines(value);
    if (!value.trim()) setEnabled(false);
    else if (!guidelines.trim()) setEnabled(true);
  }
  async function importFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('Choose a .txt or .md file.');
      if (file.size > maxLength * 4) throw new Error('This file is too large.');
      const text = await file.text();
      if (!text.trim()) throw new Error('The file is empty.');
      if (text.length > maxLength) throw new Error(`Guidelines must be ${maxLength.toLocaleString()} characters or fewer.`);
      updateGuidelines(text);
    } catch (error) { setFileError(error instanceof Error ? error.message : 'Could not import the file.'); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!save.isPending && !reload.isPending) save.mutate(); }
  const busy = save.isPending || reload.isPending;
  return <form onSubmit={submit} className="grid gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">Saved version {saved.version}</p>
      <Badge variant={saved.enabled ? 'outline' : 'secondary'}>{saved.enabled ? 'Active for new reviews' : 'Reviews paused'}</Badge>
    </div>
    <fieldset disabled={busy} className="grid min-w-0 gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Label htmlFor="workspace-guidelines">Official guidelines</Label>
          <div><Label htmlFor="guidelines-file" className="flex cursor-pointer items-center gap-2 text-sm underline underline-offset-4"><FileUp className="size-4" />Import .txt or .md</Label><input id="guidelines-file" type="file" className="sr-only" accept=".txt,.md,text/plain,text/markdown" onChange={event => void importFile(event)} /></div>
        </div>
        <Textarea id="workspace-guidelines" className="min-h-72" maxLength={maxLength} value={guidelines} onChange={event => updateGuidelines(event.target.value)} placeholder="Add your approved claims, required disclosures, prohibited content, and creative requirements." aria-describedby="guidelines-help" />
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><p id="guidelines-help">These guidelines apply to new reviews submitted by your publishers.</p><span>{guidelines.length.toLocaleString()} / {maxLength.toLocaleString()} characters</span></div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4"><div className="grid gap-1"><Label htmlFor="guidelines-enabled">Enable reviews with this policy</Label><p className="text-xs leading-5 text-muted-foreground">Pausing blocks new reviews. Existing reports keep the policy version used when they ran.</p></div><Switch id="guidelines-enabled" checked={enabled} disabled={!guidelines.trim()} onCheckedChange={value => { changed(); setEnabled(value); }} /></div>
      </div>
      <section className="grid gap-4" aria-labelledby="internal-rules-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div className="grid gap-1"><h2 id="internal-rules-heading" className="font-semibold">Internal rules &amp; exceptions</h2><p className="max-w-xl text-sm leading-6 text-muted-foreground">Optional clarifications or exceptions to your official guidelines.</p></div><Button type="button" variant="outline" disabled={rules.length >= maxRules} onClick={() => { changed(); setRules(current => [...current, { override_id: `rule-${crypto.randomUUID()}`, title: '', guidance: '', rationale: '', enabled: true }]); }}><Plus />Add rule</Button></div>
        <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-6"><p className="font-medium">When guidelines conflict</p><p className="mt-1 text-muted-foreground">An enabled internal rule takes precedence over official guidelines for the exact issue it covers. Be specific about what is permitted or prohibited. These rules apply only to {saved.display_name}; publishers cannot change them.</p></div>
        {!rules.length ? <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No internal rules. Reviews follow your official guidelines.</p> : rules.map((rule, index) => <Card key={rule.override_id}>
          <CardHeader className="gap-3"><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>Rule {index + 1}</CardTitle><div className="flex items-center gap-3"><Label htmlFor={`${rule.override_id}-enabled`}>Enabled</Label><Switch id={`${rule.override_id}-enabled`} checked={rule.enabled} onCheckedChange={value => updateRule(rule.override_id, { enabled: value })} /><Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove rule ${index + 1}`} onClick={() => { changed(); setRules(current => current.filter(item => item.override_id !== rule.override_id)); }}><Trash2 /></Button></div></div></CardHeader>
          <CardContent className="grid gap-4"><div className="grid gap-2"><Label htmlFor={`${rule.override_id}-title`}>Rule title</Label><Input id={`${rule.override_id}-title`} required maxLength={160} value={rule.title} onChange={event => updateRule(rule.override_id, { title: event.target.value })} placeholder="For example: Approved savings claim" /></div><div className="grid gap-2"><Label htmlFor={`${rule.override_id}-guidance`}>Guidance</Label><Textarea id={`${rule.override_id}-guidance`} required maxLength={isDemo() ? 2000 : 10000} value={rule.guidance} onChange={event => updateRule(rule.override_id, { guidance: event.target.value })} placeholder="Describe the exact requirement or exception and when it applies." /></div><div className="grid gap-2"><Label htmlFor={`${rule.override_id}-rationale`}>Reason (optional)</Label><Textarea id={`${rule.override_id}-rationale`} maxLength={isDemo() ? 2000 : 5000} value={rule.rationale} onChange={event => updateRule(rule.override_id, { rationale: event.target.value })} placeholder="Record why this rule applies." /></div></CardContent>
        </Card>)}
      </section>
      {fileError || save.error || reload.error ? <p role="alert" className="text-sm text-destructive">{fileError || save.error?.message || reload.error?.message}</p> : null}
      {save.isSuccess ? <p role="status" className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="size-4 shrink-0" />Version {saved.version} saved for {saved.display_name}.</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><Button type="button" variant="outline" onClick={() => { if (!dirty || window.confirm('Discard your edits and load the latest saved guidelines?')) reload.mutate(); }}>Load saved version</Button><div className="flex flex-wrap items-center gap-3"><p className="text-xs text-muted-foreground">{dirty ? 'Unsaved changes' : 'All changes saved'}</p><Button type="submit" disabled={!dirty}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}Save guidelines</Button></div></div>
    </fieldset>
  </form>;
}

export function WorkspaceSetupPage() {
  const { session } = useClientAuth();
  const { clientId } = useWorkspace();
  const portal = session.portals.find(p => p.client_id === clientId);
  const allowed = session.role === 'client' && Boolean(portal);
  const query = useQuery({ queryKey: ['workspace-guidelines', clientId], queryFn: () => getWorkspaceGuidelines(clientId), enabled: allowed, staleTime: 30_000 });
  return <ClientPortalFrame workspaceName={portal?.display_name}><div className="mx-auto grid w-full max-w-3xl gap-6">
    <section className="grid gap-2"><p className="text-sm font-medium text-muted-foreground">{portal?.display_name}</p><h1 className="text-3xl font-semibold tracking-tight">Guidelines</h1><p className="max-w-2xl text-sm leading-6 text-muted-foreground">Set the policy your publishers’ creatives are reviewed against. Only your advertiser workspace can manage these guidelines.</p></section>
    {!allowed ? <p>Only advertisers can manage review guidelines.</p> : query.error ? <div role="alert" className="grid justify-items-start gap-3"><p>{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></div> : !query.data ? <p role="status">Loading your guidelines…</p> : <>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />Your review policy</CardTitle><CardDescription>Saved for {portal?.display_name} and applied automatically to its publisher submissions.</CardDescription></CardHeader><CardContent><PolicyForm key={clientId} clientId={clientId} initial={query.data} /></CardContent></Card>
      <div className="flex flex-wrap gap-3"><Link to="/client/publishers" className={buttonVariants({ variant: 'outline' })}>Manage publishers</Link>{portal?.billing_required ? <Link to="/client/plan" className={buttonVariants({ variant: 'ghost' })}>Plan &amp; usage</Link> : null}</div>
    </>}
  </div></ClientPortalFrame>;
}
