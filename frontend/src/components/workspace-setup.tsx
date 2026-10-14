import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, FileUp, LoaderCircle, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { ClientPortalFrame, useClientAuth } from './client-dashboard';
import { useWorkspace } from './workspace-context';
import { Button, buttonVariants } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Select } from './ui/select';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import { Badge } from './ui/badge';
import { getWorkspaceGuidelines, saveWorkspaceGuidelines, importWorkspaceGuidelines, organizeWorkspaceGuidelines, type GuidelineImport, type OrganizedGuidelines, listWorkspaceVerticals, saveWorkspaceVertical, type WorkspaceVertical } from '@/lib/workspace-api';
import { isDemo } from '@/lib/demo';
import type { OfferOverride, OfferProfile } from '@/lib/api';

function verticalProfile(vertical: WorkspaceVertical): OfferProfile {
  return { offer_id: vertical.verticalId, display_name: vertical.name, official_guidelines: vertical.officialGuidelines,
    internal_overrides: vertical.internalOverrides.map(({ overrideId, ...rule }) => ({ ...rule, override_id: overrideId })),
    enabled: vertical.enabled, is_default: false, version: vertical.version, created_at: vertical.updatedAt, updated_at: vertical.updatedAt };
}
function PolicyForm({ clientId, initial, vertical, onDirtyChange }: { clientId: string; initial: OfferProfile; vertical?: WorkspaceVertical; onDirtyChange: (dirty: boolean) => void }) {
  const [saved, setSaved] = useState(initial);
  const [includeDefault, setIncludeDefault] = useState(vertical?.includeDefault ?? false);
  const [savedIncludeDefault, setSavedIncludeDefault] = useState(vertical?.includeDefault ?? false);
  const [guidelines, setGuidelines] = useState(initial.official_guidelines);
  const [rules, setRules] = useState(initial.internal_overrides);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [fileError, setFileError] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<GuidelineImport | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [organized, setOrganized] = useState<OrganizedGuidelines | null>(null);
  const [useOrganized, setUseOrganized] = useState(false);
  const cache = useQueryClient();
  const maxLength = isDemo() ? 12_000 : 200_000;
  const maxRules = isDemo() ? 10 : 100;
  const dirty = includeDefault !== savedIncludeDefault || guidelines !== saved.official_guidelines || enabled !== saved.enabled
    || JSON.stringify(rules) !== JSON.stringify(saved.internal_overrides);
  useEffect(() => { onDirtyChange(dirty || Boolean(imported)); }, [dirty, imported, onDirtyChange]);
  useEffect(() => {
    if (!dirty && !imported) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, imported]);
  function adopt(profile: OfferProfile) {
    setSaved(profile); setGuidelines(profile.official_guidelines); setRules(profile.internal_overrides); setEnabled(profile.enabled);
    if (!vertical) cache.setQueryData(['workspace-guidelines', clientId], profile);
    else void cache.invalidateQueries({ queryKey: ['workspace-verticals', clientId] });

  }
  const save = useMutation({
    mutationFn: () => vertical ? saveWorkspaceVertical(clientId, vertical.verticalId, {
      name: vertical.name, include_default: includeDefault, official_guidelines: guidelines.trim(), internal_overrides: rules, enabled, expected_version: saved.version,
    }).then(verticalProfile) : saveWorkspaceGuidelines(clientId, {
      official_guidelines: guidelines.trim(), internal_overrides: rules,
      enabled, expected_version: saved.version,
    }),
    onSuccess: profile => { adopt(profile); setSavedIncludeDefault(includeDefault); },
  });
  const reload = useMutation({ mutationFn: async () => {
    if (!vertical) return getWorkspaceGuidelines(clientId);
    const latest = (await listWorkspaceVerticals(clientId)).find(row => row.verticalId === vertical.verticalId);
    if (!latest) throw new Error('Save this new vertical before reloading it.');
    setIncludeDefault(latest.includeDefault); setSavedIncludeDefault(latest.includeDefault);
    return verticalProfile(latest);
  }, onSuccess: profile => { adopt(profile); save.reset(); setFileError(''); } });
  function changed() { save.reset(); setFileError(''); }
  function updateRule(id: string, patch: Partial<OfferOverride>) {
    changed(); setRules(current => current.map(rule => rule.override_id === id ? { ...rule, ...patch } : rule));
  }
  function updateGuidelines(value: string) {
    changed(); setGuidelines(value);
    if (!value.trim()) setEnabled(false);
    else if (!guidelines.trim()) setEnabled(true);
  }
  async function importFile(file?: File) {
    if (!file || importing) return;
    setFileError(''); setImported(null); setOrganized(null); setUseOrganized(false); setImporting(true);
    try {
      if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) throw new Error('Choose a PDF, Word (.docx), text (.txt), or Markdown (.md) file. Save older .doc files as .docx or PDF first.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Upload a file of 10 MB or less.');
      let result: GuidelineImport;
      if (/\.(txt|md)$/i.test(file.name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
        result = { filename: file.name, text: new TextDecoder(encoding, { fatal: true }).decode(bytes).trim(), warnings: [] };
      } else {
        if (isDemo()) throw new Error('PDF and Word imports are available in real advertiser workspaces. In this demo, paste text or import .txt or .md.');
        result = await importWorkspaceGuidelines(clientId, file);
      }
      if (!result.text.trim()) throw new Error('The file contains no readable text.');
      if (result.text.length > maxLength) throw new Error(`Guidelines must be ${maxLength.toLocaleString()} characters or fewer.`);
      setImported(result);
    } catch (error) { setFileError(error instanceof Error ? error.message : 'Could not import the file.'); }
    finally { setImporting(false); }
  }
  function previewDraft() {
    setImported({ filename: 'Current guideline draft', text: guidelines, warnings: [] });
    setOrganized(null); setUseOrganized(false); setFileError('');
  }
  async function organizeImport() {
    if (!imported || organizing) return;
    setOrganizing(true); setFileError('');
    try {
      if (isDemo()) throw new Error('AI organization is available in real advertiser workspaces. You can edit text directly in this demo.');
      setOrganized(await organizeWorkspaceGuidelines(clientId, imported.text));
      setUseOrganized(false);
    } catch (error) { setFileError(error instanceof Error ? error.message : 'Could not organize the text. Your original is still available.'); }
    finally { setOrganizing(false); }
  }
  function applyImport(append: boolean) {
    if (!imported) return;
    const selected = useOrganized && organized ? organized.text : imported.text;
    const next = append && guidelines.trim() ? `${guidelines.trim()}\n\n${selected}` : selected;
    if (next.length > maxLength) { setFileError(`Combined guidelines exceed ${maxLength.toLocaleString()} characters. Shorten the text or replace the existing guidelines.`); return; }
    updateGuidelines(next); setImported(null);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!busy && !imported) save.mutate(); }
  const busy = save.isPending || reload.isPending || importing || organizing;
  return <form onSubmit={submit} className="grid gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">Saved version {saved.version}</p>
      <Badge variant={saved.enabled ? 'outline' : 'secondary'}>{saved.enabled ? 'Active for new reviews' : vertical ? 'Vertical inactive' : 'Default policy paused'}</Badge>
    </div>
    <fieldset disabled={busy} className="grid min-w-0 gap-6">
      {vertical ? <div className="grid gap-2 rounded-lg border bg-muted/20 p-4"><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={includeDefault} onChange={event => { changed(); setIncludeDefault(event.target.checked); }} /><span>Also include the advertiser’s default guidelines and internal rules</span></label><p className="text-xs leading-5 text-muted-foreground">Leave this off for a separate policy. Include the default only when its requirements apply to {vertical.name}. Guidelines from other verticals are never included.</p></div> : <p className="text-sm leading-6 text-muted-foreground">The default policy is used only by verticals that explicitly include it. Put universally applicable requirements here; keep product-specific requirements in their vertical.</p>}
      <div className="grid gap-3">
        <div className="grid gap-3 rounded-lg border border-dashed bg-muted/20 p-4" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (busy) return; if (event.dataTransfer.files.length !== 1) { setFileError('Import one file at a time. You can append more documents afterward.'); return; } void importFile(event.dataTransfer.files[0]); }}>
          <Label htmlFor="guidelines-file" className="flex cursor-pointer items-center gap-2 text-sm font-medium"><FileUp className="size-4" />Upload guidelines or drop a file here</Label>
          <input id="guidelines-file" type="file" className="block w-full min-w-0 text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-2 file:text-sm" accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importFile(file); }} />
          <p className="text-xs leading-5 text-muted-foreground">PDF, Word (.docx), text, or Markdown · Up to 10 MB. Or paste below. Review the imported text before saving.</p>
          {importing ? <p role="status" className="flex items-center gap-2 text-sm"><LoaderCircle className="size-4 animate-spin" />Reading your document… Scanned PDFs may take a little longer.</p> : null}
        </div>
        {imported ? <section className="grid gap-3 rounded-lg border p-4" aria-label="Document import preview">
          <p className="break-words text-sm font-medium">Ready to import: {imported.filename}</p>
          <p className="text-xs text-muted-foreground">{imported.text.length.toLocaleString()} characters extracted. Your saved guidelines and internal rules have not changed.</p>
          {imported.warnings.map(warning => <p key={warning} className="text-sm leading-5 text-amber-800 dark:text-amber-300">{warning}</p>)}
          <p className="text-sm text-muted-foreground">Use the extraction as-is, or let AI group the wording and suggest removing clutter. Review any removals before choosing the organized version.</p>
          <div><Button type="button" variant="outline" onClick={() => void organizeImport()} disabled={Boolean(organized)}>{organizing ? <LoaderCircle className="animate-spin" /> : null}{organizing ? 'Organizing text…' : 'Clean up & organize'}</Button></div>
          {organized ? <>
            <fieldset className="grid gap-2 rounded-md bg-muted/40 p-3"><legend className="text-sm font-medium">Choose the text to use</legend><label className="flex items-center gap-2 text-sm"><input type="radio" name="import-version" checked={!useOrganized} onChange={() => setUseOrganized(false)} />Original extraction</label><label className="flex items-center gap-2 text-sm"><input type="radio" name="import-version" checked={useOrganized} onChange={() => setUseOrganized(true)} />Organized draft</label></fieldset>
            <p className="text-xs text-muted-foreground">Source wording is preserved; headings and grouping are generated. Check that conditions and exceptions remain with their requirements.</p>
            <details className="rounded-md border p-3" open={organized.removed.length > 0}><summary className="cursor-pointer text-sm font-medium">Proposed removals ({organized.removed.length})</summary>{organized.removed.length ? <div className="mt-3 grid gap-3">{organized.removed.map((item, index) => <div key={index} className="grid gap-1 border-t pt-2"><p className="whitespace-pre-wrap break-words text-sm">{item.text}</p><p className="text-xs text-muted-foreground">{item.reason}</p></div>)}</div> : <p className="mt-2 text-sm text-muted-foreground">All extracted wording is included.</p>}</details>
          </> : null}
          <Textarea aria-label={useOrganized ? 'Organized document text' : 'Extracted document text'} readOnly value={useOrganized && organized ? organized.text : imported.text} className="min-h-40" />
          <div className="flex flex-wrap gap-2"><Button type="button" onClick={() => applyImport(false)}>{guidelines.trim() ? 'Replace with selected text' : 'Use selected text'}</Button>{guidelines.trim() ? <Button type="button" variant="outline" onClick={() => applyImport(true)}>Append to guidelines</Button> : null}<Button type="button" variant="ghost" onClick={() => { setImported(null); setFileError(''); }}>Cancel import</Button></div>
        </section> : null}
        <div className="flex flex-wrap items-center justify-between gap-2"><Label htmlFor="workspace-guidelines">Official guidelines</Label>{guidelines.trim() && !imported ? <Button type="button" variant="ghost" size="sm" onClick={previewDraft}>Review &amp; organize text</Button> : null}</div>
        <Textarea id="workspace-guidelines" className="min-h-72" maxLength={maxLength} value={guidelines} onChange={event => updateGuidelines(event.target.value)} placeholder="Add your approved claims, required disclosures, prohibited content, and creative requirements." aria-describedby="guidelines-help" />
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><p id="guidelines-help">These guidelines apply to new reviews submitted by your publishers.</p><span>{guidelines.length.toLocaleString()} / {maxLength.toLocaleString()} characters</span></div>
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4"><div className="grid gap-1"><Label htmlFor="guidelines-enabled">{vertical ? 'Make this vertical available to publishers' : 'Enable the default policy'}</Label><p className="text-xs leading-5 text-muted-foreground">Disabling blocks new reviews using this policy. Existing reports keep the policy version used when they ran.</p></div><Switch id="guidelines-enabled" checked={enabled} disabled={!guidelines.trim() && !(vertical && includeDefault)} onCheckedChange={value => { changed(); setEnabled(value); }} /></div>
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
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><Button type="button" variant="outline" onClick={() => { if (!dirty || window.confirm('Discard your edits and load the latest saved guidelines?')) reload.mutate(); }}>Load saved version</Button><div className="flex flex-wrap items-center gap-3"><p className="text-xs text-muted-foreground">{imported ? 'Apply or cancel the preview before saving' : dirty ? 'Unsaved changes' : 'All changes saved'}</p><Button type="submit" disabled={!dirty || Boolean(imported)}>{save.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}Save guidelines</Button></div></div>
    </fieldset>
  </form>;
}

export function WorkspaceSetupPage() {
  const { session } = useClientAuth();
  const { clientId } = useWorkspace();
  const portal = session.portals.find(p => p.client_id === clientId);
  const allowed = session.role === 'client' && Boolean(portal);
  const [selectedVertical, setSelectedVertical] = useState<WorkspaceVertical | null>(null);
  const [editingDirty, setEditingDirty] = useState(false);
  function chooseVertical(row: WorkspaceVertical | null) {
    if (editingDirty && !window.confirm('Discard your unsaved policy draft and switch verticals?')) return;
    setEditingDirty(false); setSelectedVertical(row);
  }
  const [search, setSearch] = useState('');
  const [customName, setCustomName] = useState('');
  const [picked, setPicked] = useState('');
  const verticals = useQuery({ queryKey: ['workspace-verticals', clientId], queryFn: () => listWorkspaceVerticals(clientId), enabled: allowed });
  const query = useQuery({ queryKey: ['workspace-guidelines', clientId], queryFn: () => getWorkspaceGuidelines(clientId), enabled: allowed, staleTime: 30_000 });
  return <ClientPortalFrame workspaceName={portal?.display_name}><div className="mx-auto grid w-full max-w-3xl gap-6">
    <section className="grid gap-2"><p className="text-sm font-medium text-muted-foreground">{portal?.display_name}</p><h1 className="text-3xl font-semibold tracking-tight">Guidelines</h1><p className="max-w-2xl text-sm leading-6 text-muted-foreground">Set the policy your publishers’ creatives are reviewed against. Only your advertiser workspace can manage these guidelines.</p></section>
    {!allowed ? <p>Only advertisers can manage review guidelines.</p> : query.error ? <div role="alert" className="grid justify-items-start gap-3"><p>{query.error.message}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry</Button></div> : !query.data ? <p role="status">Loading your guidelines…</p> : <>
      <Card><CardHeader><CardTitle>Publisher verticals</CardTitle><CardDescription>Activate the categories your publishers can submit. Each upload must specify one active vertical.</CardDescription></CardHeader><CardContent className="grid gap-4">
        {verticals.error ? <p role="alert" className="text-sm text-destructive">{verticals.error.message}</p> : !verticals.data ? <p>Loading verticals…</p> : <>
          <div className="flex flex-wrap gap-2">{verticals.data.filter(row => row.enabled).map(row => <Button key={row.verticalId} type="button" variant="outline" size="sm" onClick={() => chooseVertical(row)}>{row.name}<Badge variant="secondary">Active</Badge></Button>)}{!verticals.data.some(row => row.enabled) ? <p className="text-sm text-muted-foreground">No active verticals yet. Configure one below before publishers upload.</p> : null}</div>
          <div className="grid gap-2"><Label htmlFor="vertical-search">Find a vertical</Label><Input id="vertical-search" value={search} onChange={event => { setSearch(event.target.value); setPicked(''); }} placeholder="Search insurance, solar, finance…" /><Select aria-label="Available verticals" value={picked} onValueChange={setPicked} options={[{ value: '', label: 'Choose a vertical to configure' }, ...verticals.data.filter(row => `${row.name} ${row.group}`.toLowerCase().includes(search.toLowerCase())).map(row => ({ value: row.verticalId, label: `${row.group} · ${row.name}${row.enabled ? ' · Active' : ''}` }))]} /><Button className="w-fit" type="button" variant="outline" disabled={!picked} onClick={() => chooseVertical(verticals.data.find(row => row.verticalId === picked) ?? null)}>Configure vertical</Button></div>
          <div className="grid gap-2 border-t pt-4"><Label htmlFor="custom-vertical">Missing a vertical? Add your own</Label><div className="flex flex-wrap gap-2"><Input id="custom-vertical" className="min-w-0 flex-1" value={customName} maxLength={100} onChange={event => setCustomName(event.target.value)} placeholder="Vertical name" /><Button type="button" variant="outline" disabled={customName.trim().length < 2} onClick={() => { const name = customName.trim(); chooseVertical({ verticalId: `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'vertical'}-${crypto.randomUUID().slice(0, 8)}`, name, enabled: false, includeDefault: false, officialGuidelines: '', internalOverrides: [], version: 0, updatedAt: 0, group: 'Custom' }); setCustomName(''); }}>Add custom vertical</Button></div></div>
        </>}
      </CardContent></Card>
      <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" />{selectedVertical ? selectedVertical.name : 'Default guidelines'}</CardTitle>{selectedVertical ? <Button variant="ghost" onClick={() => chooseVertical(null)}>Edit default policy</Button> : null}</div><CardDescription>{selectedVertical ? `Only ${selectedVertical.name} submissions use this vertical’s guidelines.` : `Existing guidelines for ${portal?.display_name}. Changes apply to future reviews only.`}</CardDescription></CardHeader><CardContent><PolicyForm key={`${clientId}:${selectedVertical?.verticalId ?? 'default'}`} clientId={clientId} initial={selectedVertical ? verticalProfile(selectedVertical) : query.data} vertical={selectedVertical ?? undefined} onDirtyChange={setEditingDirty} /></CardContent></Card>
      <div className="flex flex-wrap gap-3"><Link to="/client/publishers" className={buttonVariants({ variant: 'outline' })}>Manage publishers</Link>{portal?.billing_required ? <Link to="/client/plan" className={buttonVariants({ variant: 'ghost' })}>Plan &amp; usage</Link> : null}</div>
    </>}
  </div></ClientPortalFrame>;
}
