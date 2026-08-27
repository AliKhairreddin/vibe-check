import { useState, type ReactNode } from 'react';
import { CheckCircle2, LayoutGrid, List, RotateCcw, Save, Settings2 } from 'lucide-react';

import { ClientPortalFrame } from '@/components/client-dashboard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  readClientPreferences,
  resetClientPreferences,
  saveClientPreferences,
  type ClientPreferences,
} from '@/lib/client-preferences';
import { cn } from '@/lib/utils';

export function ClientSettingsPage() {
  const [preferences, setPreferences] = useState<ClientPreferences>(() => readClientPreferences());
  const [saved, setSaved] = useState(false);

  function update<K extends keyof ClientPreferences>(key: K, value: ClientPreferences[K]) {
    setSaved(false);
    setPreferences((current) => ({ ...current, [key]: value }));
  }

  function save() {
    saveClientPreferences(preferences);
    setSaved(true);
  }

  function reset() {
    setPreferences(resetClientPreferences());
    setSaved(true);
  }

  return (
    <ClientPortalFrame>
      <div className="mx-auto grid w-full max-w-4xl gap-5">
        <section className="grid gap-1">
          <p className="text-sm font-medium text-muted-foreground">Workspace preferences</p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Choose how the creative review queue opens and looks on this browser.
          </p>
        </section>

        {saved ? (
          <Alert className="border-emerald-600/25 bg-emerald-500/5">
            <CheckCircle2 className="text-emerald-700" />
            <AlertTitle>Preferences saved</AlertTitle>
            <AlertDescription>Your creative review queue will use these defaults next time it opens.</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Default review layout</CardTitle>
            <CardDescription>Choose the first view shown when you open Creative reviews.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <PreferenceOption
              active={preferences.reviewView === 'grid'}
              description="Cards arranged side by side for visual scanning."
              icon={<LayoutGrid />}
              label="Grid view"
              onClick={() => update('reviewView', 'grid')}
            />
            <PreferenceOption
              active={preferences.reviewView === 'list'}
              description="Table-like rows with result, findings, and decision columns."
              icon={<List />}
              label="List view"
              onClick={() => update('reviewView', 'list')}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue defaults</CardTitle>
            <CardDescription>Set the amount of information and the starting state of the queue.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="client-density">Display density</Label>
              <select
                id="client-density"
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={preferences.density}
                onChange={(event) => update('density', event.currentTarget.value as ClientPreferences['density'])}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
              <p className="text-xs leading-5 text-muted-foreground">Compact fits more creatives on screen.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="client-result-filter">Default result filter</Label>
              <select
                id="client-result-filter"
                className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={preferences.defaultResultFilter}
                onChange={(event) => update('defaultResultFilter', event.currentTarget.value as ClientPreferences['defaultResultFilter'])}
              >
                <option value="all">All colors</option>
                <option value="green">Green only</option>
                <option value="yellow">Yellow only</option>
                <option value="red">Red only</option>
              </select>
              <p className="text-xs leading-5 text-muted-foreground">You can still change this from the queue at any time.</p>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border p-3 sm:col-span-2">
              <div className="grid gap-1">
                <Label htmlFor="client-expand-batch">Open newest batch automatically</Label>
                <p className="text-xs leading-5 text-muted-foreground">Turn this off to start with every batch collapsed.</p>
              </div>
              <Switch
                id="client-expand-batch"
                checked={preferences.autoExpandNewestBatch}
                onCheckedChange={(checked) => update('autoExpandNewestBatch', checked)}
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={reset}>
            <RotateCcw />Reset defaults
          </Button>
          <Button type="button" onClick={save}>
            <Save />Save preferences
          </Button>
        </div>

        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Settings2 className="size-3.5" />Preferences are stored in this browser and do not change review results or decisions.
        </p>
      </div>
    </ClientPortalFrame>
  );
}

function PreferenceOption({ active, description, icon, label, onClick }: {
  active: boolean;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'grid gap-2 rounded-xl border p-4 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring',
        active && 'border-primary bg-muted/35 ring-1 ring-primary/10'
      )}
      onClick={onClick}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="grid size-9 place-items-center rounded-lg border bg-background text-muted-foreground">{icon}</span>
        {active ? <CheckCircle2 className="size-5" /> : null}
      </span>
      <span className="font-semibold">{label}</span>
      <span className="text-sm leading-6 text-muted-foreground">{description}</span>
    </button>
  );
}
