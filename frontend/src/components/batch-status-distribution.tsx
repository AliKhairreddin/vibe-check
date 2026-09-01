import { ArrowRight, ChartNoAxesColumnIncreasing, ShieldCheck, UserRoundCheck } from 'lucide-react';

import { batchOutcomeForOffer, type OfferColumn } from '@/components/offer-outcomes';
import type { OfferOutcome, OverallStatus, ReviewBatchItem } from '@/lib/api';
import { cn } from '@/lib/utils';

const RESULT_ORDER: OverallStatus[] = ['green', 'yellow', 'red'];
const RESULT_META: Record<OverallStatus, { barClass: string; label: string; valueClass: string }> = {
  green: { barClass: 'bg-emerald-500', label: 'Green', valueClass: 'text-emerald-700 dark:text-emerald-300' },
  yellow: { barClass: 'bg-yellow-400', label: 'Yellow', valueClass: 'text-yellow-700 dark:text-yellow-300' },
  red: { barClass: 'bg-red-500', label: 'Red', valueClass: 'text-red-700 dark:text-red-300' },
};

type ResultLayer = 'assessment' | 'effective';

function outcomesForScope(items: ReviewBatchItem[], offer: OfferColumn | null) {
  return items.flatMap((item) => {
    if (offer) {
      const outcome = batchOutcomeForOffer(item, offer);
      return outcome?.evaluation_state === 'evaluated' ? [outcome] : [];
    }
    return (item.offer_outcomes ?? []).filter((outcome) => outcome.evaluation_state === 'evaluated');
  });
}

function statusForLayer(outcome: OfferOutcome, layer: ResultLayer): OverallStatus | null {
  if (layer === 'assessment') return outcome.automated_status ?? outcome.overall_status;
  return outcome.effective_status ?? outcome.overall_status;
}

function resultCounts(outcomes: OfferOutcome[], layer: ResultLayer): Record<OverallStatus, number> {
  const counts: Record<OverallStatus, number> = { green: 0, yellow: 0, red: 0 };
  for (const outcome of outcomes) {
    const status = statusForLayer(outcome, layer);
    if (status) counts[status] += 1;
  }
  return counts;
}

export function batchStatusCounts(
  items: ReviewBatchItem[],
  offer: OfferColumn | null = null
): Record<OverallStatus, number> {
  return resultCounts(outcomesForScope(items, offer), 'effective');
}

export function BatchStatusDistribution({
  items,
  offers,
  selectedOfferId,
  onOfferChange,
}: {
  items: ReviewBatchItem[];
  offers: OfferColumn[];
  selectedOfferId: string;
  onOfferChange: (offerId: string) => void;
}) {
  const selectedOffer = offers.find((offer) => offer.offer_id === selectedOfferId) ?? null;
  const outcomes = outcomesForScope(items, selectedOffer);
  const assessmentCounts = resultCounts(outcomes, 'assessment');
  const effectiveCounts = resultCounts(outcomes, 'effective');
  const decisionCounts = {
    approved: outcomes.filter((outcome) => outcome.client_decision === 'approved').length,
    pending: outcomes.filter((outcome) => !outcome.client_decision).length,
    disapproved: outcomes.filter((outcome) => outcome.client_decision === 'disapproved').length,
  };
  const total = outcomes.length;
  const resultScope = selectedOffer ? ` for ${selectedOffer.offer_name}` : ' across this batch';

  return (
    <section className="mb-6 grid gap-4 rounded-xl border bg-muted/20 p-4" aria-labelledby="batch-status-distribution-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <h2 id="batch-status-distribution-title" className="text-sm font-medium">Result layers</h2>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {total
              ? `${total} evaluated offer result${total === 1 ? '' : 's'}${resultScope}`
              : selectedOffer
                ? `No completed ${selectedOffer.offer_name} results yet`
                : 'No completed offer results yet'}
          </p>
        </div>
        <label className="grid gap-1 sm:min-w-44">
          <span className="text-xs font-medium text-muted-foreground">Filter by offer</span>
          <select
            value={selectedOfferId}
            onChange={(event) => onOfferChange(event.currentTarget.value)}
            className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          >
            <option value="all">All offers</option>
            {offers.map((offer) => <option key={offer.offer_id} value={offer.offer_id}>{offer.offer_name}</option>)}
          </select>
        </label>
      </div>

      <div className="grid items-stretch gap-2 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <ResultLayerCard counts={assessmentCounts} description="Immutable policy evaluation" icon={ShieldCheck} label="AdChecked assessment" />
        <ArrowRight className="mx-auto hidden size-4 self-center text-muted-foreground xl:block" aria-hidden="true" />
        <DecisionLayerCard counts={decisionCounts} total={total} />
        <ArrowRight className="mx-auto hidden size-4 self-center text-muted-foreground xl:block" aria-hidden="true" />
        <ResultLayerCard counts={effectiveCounts} description="Current operational status" icon={ChartNoAxesColumnIncreasing} label="Effective disposition" operational />
      </div>

      <p className="rounded-lg border bg-background/70 px-3 py-2 text-xs leading-5 text-muted-foreground">
        A client decision can resolve a yellow assessment operationally, but the original AdChecked result remains visible for audit history.
      </p>
    </section>
  );
}

function ResultLayerCard({ counts, description, icon: Icon, label, operational = false }: {
  counts: Record<OverallStatus, number>;
  description: string;
  icon: typeof ShieldCheck;
  label: string;
  operational?: boolean;
}) {
  const total = RESULT_ORDER.reduce((sum, status) => sum + counts[status], 0);
  return (
    <div className="grid content-start gap-3 rounded-lg border bg-background/85 p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"><Icon className="size-4" /></span>
        <span><span className="block text-sm font-medium">{label}</span><span className="block text-[11px] text-muted-foreground">{description}</span></span>
      </div>
      <ResultBar counts={counts} total={total} label={label} />
      <div className="grid grid-cols-3 gap-2">
        {RESULT_ORDER.map((status) => (
          <span key={status} className="min-w-0">
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><span className={cn('size-1.5 rounded-full', RESULT_META[status].barClass)} />{operational ? operationalLabel(status) : RESULT_META[status].label}</span>
            <span className={cn('block text-lg font-semibold tabular-nums', RESULT_META[status].valueClass)}>{counts[status]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function DecisionLayerCard({ counts, total }: { counts: { approved: number; pending: number; disapproved: number }; total: number }) {
  const values = [
    { key: 'approved', label: 'Approved', value: counts.approved, className: 'bg-emerald-500', valueClass: 'text-emerald-700 dark:text-emerald-300' },
    { key: 'pending', label: 'Pending', value: counts.pending, className: 'bg-yellow-400', valueClass: 'text-yellow-700 dark:text-yellow-300' },
    { key: 'disapproved', label: 'Disapproved', value: counts.disapproved, className: 'bg-red-500', valueClass: 'text-red-700 dark:text-red-300' },
  ];
  return (
    <div className="grid content-start gap-3 rounded-lg border bg-background/85 p-3">
      <div className="flex items-center gap-2">
        <span className="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"><UserRoundCheck className="size-4" /></span>
        <span><span className="block text-sm font-medium">Client decision</span><span className="block text-[11px] text-muted-foreground">Final human choice</span></span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={values.map((item) => `${item.label} ${item.value}`).join(', ')}>
        {values.map((item) => item.value ? <span key={item.key} className={item.className} style={{ width: `${total ? (item.value / total) * 100 : 0}%` }} /> : null)}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {values.map((item) => <span key={item.key} className="min-w-0"><span className="flex items-center gap-1 text-[11px] text-muted-foreground"><span className={cn('size-1.5 rounded-full', item.className)} />{item.label}</span><span className={cn('block text-lg font-semibold tabular-nums', item.valueClass)}>{item.value}</span></span>)}
      </div>
    </div>
  );
}

function ResultBar({ counts, label, total }: { counts: Record<OverallStatus, number>; label: string; total: number }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${label}: ${RESULT_ORDER.map((status) => `${RESULT_META[status].label} ${counts[status]}`).join(', ')}`}>
      {RESULT_ORDER.map((status) => counts[status] ? <span key={status} className={RESULT_META[status].barClass} style={{ width: `${total ? (counts[status] / total) * 100 : 0}%` }} /> : null)}
    </div>
  );
}

function operationalLabel(status: OverallStatus) {
  if (status === 'green') return 'Ready';
  if (status === 'red') return 'Hold';
  return 'Needs decision';
}
