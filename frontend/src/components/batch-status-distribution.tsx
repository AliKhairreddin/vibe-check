import { cn } from '@/lib/utils';
import type { OverallStatus, ReviewBatchItem } from '@/lib/api';

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

export function batchStatusCounts(items: ReviewBatchItem[]): Record<OverallStatus, number> {
  const counts: Record<OverallStatus, number> = { green: 0, yellow: 0, red: 0 };
  for (const item of items) {
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

export function BatchStatusDistribution({ items }: { items: ReviewBatchItem[] }) {
  const counts = batchStatusCounts(items);
  const total = RESULT_ORDER.reduce((sum, status) => sum + counts[status], 0);
  const accessibleLabel = total
    ? RESULT_ORDER.map((status) => `${RESULT_META[status].label} ${counts[status]}`).join(', ')
    : 'No completed offer results';

  return (
    <section className="mb-6 grid gap-4 rounded-xl border bg-muted/20 p-4" aria-labelledby="batch-status-distribution-title">
      <div className="grid gap-1">
        <h2 id="batch-status-distribution-title" className="text-sm font-medium">Batch status distribution</h2>
        <p className="text-xs text-muted-foreground">
          {total
            ? `${total} completed offer result${total === 1 ? '' : 's'} across this batch`
            : 'No completed offer results yet'}
        </p>
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
