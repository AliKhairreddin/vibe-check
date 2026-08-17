import { cn } from '@/lib/utils';
import type { OverallStatus, ReviewBatchItem } from '@/lib/api';
import { batchOutcomeForOffer, type OfferColumn } from '@/components/offer-outcomes';

const RESULT_ORDER: OverallStatus[] = ['green', 'yellow', 'red'];
const RESULT_META: Record<OverallStatus, {
  barClass: string;
  label: string;
  valueClass: string;
}> = {
  green: {
    barClass: 'bg-emerald-500',
    label: 'Green',
    valueClass: 'text-emerald-700 dark:text-emerald-300',
  },
  yellow: {
    barClass: 'bg-yellow-400',
    label: 'Yellow',
    valueClass: 'text-yellow-700 dark:text-yellow-300',
  },
  red: {
    barClass: 'bg-red-500',
    label: 'Red',
    valueClass: 'text-red-700 dark:text-red-300',
  },
};

export function batchStatusCounts(
  items: ReviewBatchItem[],
  offer: OfferColumn | null = null
): Record<OverallStatus, number> {
  const counts: Record<OverallStatus, number> = { green: 0, yellow: 0, red: 0 };
  for (const item of items) {
    if (offer) {
      const outcome = batchOutcomeForOffer(item, offer);
      if (outcome?.evaluation_state === 'evaluated' && outcome.overall_status) {
        counts[outcome.overall_status] += 1;
      }
      continue;
    }
    const evaluatedOutcomes = (item.offer_outcomes ?? []).filter((outcome) => (
      outcome.evaluation_state === 'evaluated' && outcome.overall_status
    ));
    if (evaluatedOutcomes.length) {
      for (const outcome of evaluatedOutcomes) {
        if (outcome.overall_status) counts[outcome.overall_status] += 1;
      }
      continue;
    }
    if (item.status === 'complete' && item.result) counts[item.result] += 1;
  }
  return counts;
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
  const counts = batchStatusCounts(items, selectedOffer);
  const total = RESULT_ORDER.reduce((sum, status) => sum + counts[status], 0);
  const accessibleLabel = total
    ? RESULT_ORDER.map((status) => `${RESULT_META[status].label} ${counts[status]}`).join(', ')
    : 'No completed offer results';
  const resultScope = selectedOffer ? ` for ${selectedOffer.offer_name}` : ' across this batch';

  return (
    <section className="mb-6 grid gap-4 rounded-xl border bg-muted/20 p-4" aria-labelledby="batch-status-distribution-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid gap-1">
          <h2 id="batch-status-distribution-title" className="text-sm font-medium">Batch status distribution</h2>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {total
              ? `${total} completed offer result${total === 1 ? '' : 's'}${resultScope}`
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
            {offers.map((offer) => (
              <option key={offer.offer_id} value={offer.offer_id}>
                {offer.offer_name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={accessibleLabel}
      >
        {total ? RESULT_ORDER.map((status) => (
          <span
            key={status}
            className={RESULT_META[status].barClass}
            style={{ width: `${(counts[status] / total) * 100}%` }}
          />
        )) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {RESULT_ORDER.map((status) => {
          const meta = RESULT_META[status];
          const percent = total ? Math.round((counts[status] / total) * 100) : 0;
          return (
            <div key={status} className="flex items-center justify-between gap-3 rounded-lg border bg-background/80 px-3 py-2.5">
              <div className="grid gap-1">
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <span className={cn('size-2 rounded-full', meta.barClass)} />
                  {meta.label}
                </span>
                <span className="text-xs text-muted-foreground">{percent}% of results</span>
              </div>
              <span className={cn('text-2xl font-semibold tabular-nums', meta.valueClass)}>{counts[status]}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
