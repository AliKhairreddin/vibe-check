import { Popover } from '@base-ui/react/popover';
import { Check, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Cell, Pie, PieChart } from 'recharts';

import { Badge } from '@/components/ui/badge';
import type {
  OfferCatalogItem,
  OfferOutcome,
  OverallStatus,
  ReviewBatchItem,
  ReviewHistoryItem,
} from '@/lib/api';
import { cn } from '@/lib/utils';

export type OfferColumn = {
  offer_id: string;
  offer_name: string;
};

const CANONICAL_OFFERS: OfferColumn[] = [
  { offer_id: 'acp', offer_name: 'ACP' },
  { offer_id: 'kissterra', offer_name: 'Kissterra' },
  { offer_id: 'lead-economy', offer_name: 'Lead Economy' },
  { offer_id: 'smart-financial', offer_name: 'Smart Financial' },
];

const STATUS_META: Record<
  OverallStatus,
  { label: string; className: string; railClassName: string }
> = {
  green: {
    label: 'Green',
    className: 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300',
    railClassName: 'bg-emerald-500 dark:bg-emerald-400',
  },
  yellow: {
    label: 'Yellow',
    className: 'border-yellow-600/30 bg-yellow-400/15 text-yellow-700 dark:border-yellow-400/30 dark:bg-yellow-400/15 dark:text-yellow-300',
    railClassName: 'bg-yellow-400 dark:bg-yellow-300',
  },
  red: {
    label: 'Red',
    className: 'border-red-600/30 bg-red-500/15 text-red-700 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-300',
    railClassName: 'bg-red-500 dark:bg-red-400',
  },
};

function canonicalIndex(offerId: string) {
  const index = CANONICAL_OFFERS.findIndex((offer) => offer.offer_id === offerId);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

export function getOfferColumns(
  catalog: Pick<OfferCatalogItem, 'offer_id' | 'display_name'>[] = [],
  outcomeGroups: Array<OfferOutcome[] | undefined> = []
): OfferColumn[] {
  const columns = new Map(CANONICAL_OFFERS.map((offer) => [offer.offer_id, offer]));

  for (const outcomes of outcomeGroups) {
    for (const outcome of outcomes ?? []) {
      columns.set(outcome.offer_id, {
        offer_id: outcome.offer_id,
        offer_name: outcome.offer_name,
      });
    }
  }
  // Current catalog labels are authoritative. Historical snapshots only add
  // missing IDs, so loading an older renamed review cannot change a heading.
  for (const offer of catalog) {
    columns.set(offer.offer_id, {
      offer_id: offer.offer_id,
      offer_name: offer.display_name,
    });
  }

  return Array.from(columns.values()).sort((left, right) => {
    const order = canonicalIndex(left.offer_id) - canonicalIndex(right.offer_id);
    return order || left.offer_name.localeCompare(right.offer_name);
  });
}

export function findOfferOutcome(
  outcomes: OfferOutcome[] | undefined,
  offerId: string
): OfferOutcome | null {
  return outcomes?.find((outcome) => outcome.offer_id === offerId) ?? null;
}

export function reviewOutcomeForOffer(
  review: ReviewHistoryItem,
  offer: OfferColumn
): OfferOutcome | null {
  const outcome = findOfferOutcome(review.offer_outcomes, offer.offer_id);
  if (review.offer_ids?.includes(offer.offer_id) && !review.report_ready && review.status !== 'failed') {
    return {
      offer_id: offer.offer_id,
      offer_name: offer.offer_name,
      evaluation_state: 'evaluated',
      overall_status: null,
      creative_result: null,
      ad_copy_result: null,
      message: 'Review in progress.',
    };
  }
  if (outcome) return outcome;

  const primaryOfferId = review.primary_offer_id ?? review.offer_ids?.[0] ?? 'acp';
  if (primaryOfferId !== offer.offer_id || !review.overall_status) return null;
  const overall = normalizeStatus(review.overall_status);
  if (!overall) return null;
  return {
    offer_id: offer.offer_id,
    offer_name: offer.offer_name,
    evaluation_state: 'evaluated',
    overall_status: overall,
    creative_result: normalizeStatus(review.creative_result),
    ad_copy_result: normalizeStatus(review.ad_copy_result),
    message: 'Legacy primary-offer result.',
  };
}

export function batchOutcomeForOffer(
  item: ReviewBatchItem,
  offer: OfferColumn
): OfferOutcome | null {
  const outcome = findOfferOutcome(item.offer_outcomes, offer.offer_id);
  if (outcome) {
    const failed = item.status === 'failed' || item.status === 'upload_failed';
    if (failed && outcome.evaluation_state === 'evaluated' && !outcome.overall_status) return null;
    return outcome;
  }
  // Only synthesize ACP for old batch rows that predate per-offer snapshots.
  // A modern Kissterra-only row has an outcome list but intentionally no ACP
  // outcome; treating its primary result as ACP duplicates the verdict.
  if ((item.offer_outcomes?.length ?? 0) > 0 || offer.offer_id !== 'acp' || !item.result) {
    return null;
  }
  return {
    offer_id: offer.offer_id,
    offer_name: offer.offer_name,
    evaluation_state: 'evaluated',
    overall_status: item.result,
    creative_result: item.media_kind === 'copy_only' ? null : item.result,
    ad_copy_result: item.media_kind === 'copy_only' ? item.result : null,
    message: 'Legacy batch result.',
  };
}

export function OfferResultBadge({
  automatedStatus,
  className,
  clientDecision,
  status,
  withOverride = false,
}: {
  className?: string;
  automatedStatus?: OverallStatus | null;
  clientDecision?: OfferOutcome['client_decision'];
  status: OverallStatus | null | undefined;
  withOverride?: boolean;
}) {
  if (!status) return <Badge variant="outline" className={className}>N/A</Badge>;
  const meta = STATUS_META[status];
  const isClientOverride = Boolean(clientDecision && automatedStatus && automatedStatus !== status);
  return (
    <Badge variant="outline" className={cn(meta.className, className)}>
      {isClientOverride
        ? `${meta.label} · Client ${clientDecision === 'approved' ? 'approved' : 'disapproved'}`
        : status === 'green' && withOverride ? 'Green · Exception' : meta.label}
    </Badge>
  );
}

export function OfferOutcomeCell({
  compact = false,
  outcome,
  showSources = false,
}: {
  compact?: boolean;
  outcome: OfferOutcome | null | undefined;
  showSources?: boolean;
}) {
  if (!outcome || outcome.evaluation_state !== 'evaluated') {
    const message = outcome?.message || unavailableMessage(outcome?.evaluation_state);
    return (
      <div className={cn('grid min-w-24 gap-1', compact && 'min-w-0 max-w-full overflow-hidden')} title={message}>
        <Badge variant="outline" className="w-fit text-muted-foreground">N/A</Badge>
        {!compact ? <span className="max-w-40 text-xs leading-4 text-muted-foreground">{message}</span> : null}
      </div>
    );
  }

  const compactDetails = compact ? outcomeDetails(outcome) : undefined;

  return (
    <div
      className={cn('grid min-w-24 gap-1', compact && 'min-w-0 max-w-full overflow-hidden')}
      title={compactDetails}
    >
      {outcome.overall_status ? (
        <OfferResultBadge
          automatedStatus={outcome.automated_status}
          className={cn('w-fit', compact && 'min-w-0 max-w-full justify-start truncate')}
          clientDecision={outcome.client_decision}
          status={outcome.overall_status}
          withOverride={outcome.with_override}
        />
      ) : (
        <Badge variant="outline" className={cn('w-fit', compact && 'min-w-0 max-w-full justify-start truncate')}>Not ready</Badge>
      )}
      {showSources && (outcome.creative_result || outcome.ad_copy_result) ? (
        <span className="text-xs leading-4 text-muted-foreground">
          {outcome.creative_result ? `Creative: ${STATUS_META[outcome.creative_result].label}` : ''}
          {outcome.creative_result && outcome.ad_copy_result ? ' · ' : ''}
          {outcome.ad_copy_result ? `Copy: ${STATUS_META[outcome.ad_copy_result].label}` : ''}
        </span>
      ) : null}
    </div>
  );
}

export function OfferResultsHeader({ offers }: { offers: OfferColumn[] }) {
  return (
    <div className="grid gap-1 py-1">
      <span>Offer results</span>
      <div
        className="grid gap-px"
        style={{
          gridTemplateColumns: `repeat(${Math.max(offers.length, 1)}, minmax(0, 1fr))`,
        }}
      >
        {offers.map((offer) => (
          <span
            key={offer.offer_id}
            className="truncate pr-1 text-[10px] leading-3 font-normal text-muted-foreground"
            title={offer.offer_name}
          >
            {offer.offer_name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ReviewOfferResultsRail({
  offers,
  review,
}: {
  offers: OfferColumn[];
  review: ReviewHistoryItem;
}) {
  const segments = offers.map((offer) => {
    const outcome = reviewOutcomeForOffer(review, offer);
    const meta = railOutcomeMeta(outcome);
    return { ...meta, offer };
  });

  return <OfferResultsRail segments={segments} />;
}

export function BatchOfferResultsRail({
  item,
  offers,
}: {
  item: ReviewBatchItem;
  offers: OfferColumn[];
}) {
  const segments = offers.map((offer) => {
    const outcome = batchOutcomeForOffer(item, offer);
    const meta = railOutcomeMeta(outcome);
    return { ...meta, offer };
  });

  return <OfferResultsRail prominent segments={segments} />;
}

export function BatchHistoryOfferResultsRail({
  items,
  offers,
}: {
  items: ReviewBatchItem[];
  offers: OfferColumn[];
}) {
  const groups = offers.map((offer) => summarizeBatchOffer(items, offer));

  return (
    <div
      className="grid h-6 w-full min-w-0 gap-1"
      style={{
        gridTemplateColumns: `repeat(${Math.max(groups.length, 1)}, minmax(0, 1fr))`,
      }}
      role="group"
      aria-label="Batch results by offer. Open an offer for its detailed breakdown."
    >
      {groups.map((group) => <BatchOfferSummaryPopover key={group.offer.offer_id} group={group} />)}
    </div>
  );
}

type BatchResultCategoryKey = OverallStatus | 'na' | 'not-ready';

type BatchResultCategory = {
  key: BatchResultCategoryKey;
  label: string;
  count: number;
  className: string;
  chartColor: string;
};

type BatchOfferSummary = {
  offer: OfferColumn;
  categories: BatchResultCategory[];
  total: number;
  exceptionCount: number;
  accessibleSummary: string;
};

const BATCH_RESULT_CATEGORIES: Array<Omit<BatchResultCategory, 'count'>> = [
  {
    key: 'green',
    label: 'Green',
    className: STATUS_META.green.railClassName,
    chartColor: '#10b981',
  },
  {
    key: 'yellow',
    label: 'Yellow',
    className: STATUS_META.yellow.railClassName,
    chartColor: '#facc15',
  },
  {
    key: 'red',
    label: 'Red',
    className: STATUS_META.red.railClassName,
    chartColor: '#ef4444',
  },
  {
    key: 'na',
    label: 'N/A',
    className: 'bg-muted-foreground/15',
    chartColor: '#a1a1aa',
  },
  {
    key: 'not-ready',
    label: 'Not ready',
    className: 'bg-muted-foreground/35',
    chartColor: '#71717a',
  },
];

function BatchOfferSummaryPopover({ group }: { group: BatchOfferSummary }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        type="button"
        openOnHover
        delay={160}
        closeDelay={180}
        onFocus={() => window.requestAnimationFrame(() => setOpen(true))}
        className="group flex h-6 min-w-0 items-center rounded-md px-1 outline-none transition-colors hover:bg-muted data-popup-open:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
        aria-label={`${group.offer.offer_name} results: ${group.accessibleSummary}. Open breakdown.`}
      >
        <span
          aria-hidden="true"
          className="flex h-2.5 w-full min-w-0 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10 transition-transform group-hover:scale-y-125 group-data-popup-open:scale-y-125"
        >
          {group.categories.map((category) => (
            <span
              key={category.key}
              className={cn('h-full min-w-px', category.className)}
              style={{ flexGrow: category.count, flexBasis: 0 }}
            />
          ))}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} className="z-50 max-w-[calc(100vw-1rem)]">
          <Popover.Popup className="w-[19rem] max-w-[calc(100vw-1rem)] origin-[var(--transform-origin)] rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <Popover.Title className="text-sm font-semibold">{group.offer.offer_name}</Popover.Title>
            <Popover.Description className="mt-0.5 text-xs text-muted-foreground">
              {group.total} creative{group.total === 1 ? '' : 's'} in this batch
            </Popover.Description>

            <div className="mt-3 grid grid-cols-[7rem_1fr] items-center gap-3">
              <div
                role="img"
                aria-label={`${group.offer.offer_name} result distribution: ${group.accessibleSummary}`}
                className="size-28"
              >
                <PieChart width={112} height={112} accessibilityLayer={false}>
                  <Pie
                    data={group.categories}
                    dataKey="count"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={32}
                    outerRadius={51}
                    paddingAngle={group.categories.length > 1 ? 1 : 0}
                    stroke="none"
                    isAnimationActive={false}
                  >
                    {group.categories.map((category) => (
                      <Cell key={category.key} fill={category.chartColor} />
                    ))}
                  </Pie>
                </PieChart>
              </div>

              <dl className="grid gap-2">
                {group.categories.map((category) => (
                  <div key={category.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-xs">
                    <span
                      aria-hidden="true"
                      className={cn('size-2.5 rounded-full', category.className)}
                    />
                    <dt>{category.label}</dt>
                    <dd className="tabular-nums text-muted-foreground">
                      {category.count} · {formatBatchPercentage(category.count, group.total)}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {group.exceptionCount > 0 ? (
              <p className="mt-3 border-t pt-3 text-xs leading-4 text-muted-foreground">
                {group.exceptionCount} Green result{group.exceptionCount === 1 ? '' : 's'} use{group.exceptionCount === 1 ? 's' : ''} an approved internal exception.
              </p>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

type OfferRailSegment = ReturnType<typeof railOutcomeMeta> & { offer: OfferColumn };

function OfferResultsRail({
  prominent = false,
  segments,
}: {
  prominent?: boolean;
  segments: OfferRailSegment[];
}) {
  const accessibleLabel = segments
    .map(({ label, offer }) => `${offer.offer_name}: ${label}`)
    .join(', ');

  return (
    <div
      className={cn(
        'grid w-full min-w-0 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10',
        prominent ? 'h-6' : 'h-2.5'
      )}
      style={{
        gridTemplateColumns: `repeat(${Math.max(segments.length, 1)}, minmax(0, 1fr))`,
      }}
      role="img"
      aria-label={accessibleLabel || 'No offer results'}
    >
      {segments.map(({ className, label, offer, withOverride }, index) => (
        <span
          key={offer.offer_id}
          className={cn(
            'grid h-full place-items-center',
            index > 0 && 'border-l border-card/90',
            className
          )}
          title={`${offer.offer_name}: ${label}`}
        >
          {prominent && withOverride ? (
            <ShieldCheck aria-hidden="true" className="size-3.5 text-white drop-shadow-sm" />
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function OfferEligibilityGrid({
  offers,
  selectedOfferIds,
  onToggle,
}: {
  offers: OfferCatalogItem[];
  selectedOfferIds: Set<string>;
  onToggle: (offerId: string) => void;
}) {
  const columns = getOfferColumns(offers);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {columns.map((column) => {
        const offer = offers.find((candidate) => candidate.offer_id === column.offer_id);
        const eligible = Boolean(offer?.enabled && offer.configured);
        const selected = eligible && selectedOfferIds.has(column.offer_id);
        const message = eligibilityMessage(offer);
        return (
          <button
            key={column.offer_id}
            type="button"
            disabled={!eligible}
            aria-pressed={selected}
            aria-label={`${selected ? 'Exclude' : 'Include'} ${column.offer_name} in this review`}
            onClick={() => onToggle(column.offer_id)}
            className={cn(
              'flex items-center justify-between gap-3 rounded-lg border bg-background p-3 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
              eligible && 'cursor-pointer hover:bg-accent/50',
              selected && 'border-primary/50 bg-primary/5',
              !eligible && 'cursor-not-allowed opacity-60'
            )}
          >
            <span className="flex min-w-0 items-start gap-2.5">
              <span className={cn(
                'mt-0.5 grid size-5 shrink-0 place-items-center rounded border',
                selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
              )} aria-hidden="true">
                {selected ? <Check className="size-3.5" /> : null}
              </span>
              <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{column.offer_name}</span>
              <span className="block text-xs leading-5 text-muted-foreground">{message}</span>
              </span>
            </span>
            <Badge variant={selected ? 'secondary' : 'outline'} className="shrink-0">
              {selected ? 'Included' : eligible ? 'Excluded' : 'N/A'}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}

function eligibilityMessage(offer: OfferCatalogItem | undefined) {
  if (!offer) return 'Offer profile has not been created.';
  if (!offer.enabled) return 'Turned off in Settings.';
  if (!offer.configured) return 'Add official guidelines to enable reviews.';
  return `Guidelines v${offer.version} · ${offer.override_count} internal rules`;
}

function unavailableMessage(state: OfferOutcome['evaluation_state'] | undefined) {
  if (state === 'disabled') return 'Offer was turned off for this review.';
  if (state === 'missing_guidelines') return 'No guidelines were available for this review.';
  return 'No offer result was saved for this review.';
}

function railOutcomeMeta(outcome: OfferOutcome | null) {
  if (!outcome || outcome.evaluation_state !== 'evaluated') {
    return {
      className: 'bg-muted-foreground/15',
      label: 'N/A',
      withOverride: false,
    };
  }
  if (!outcome.overall_status) {
    return {
      className: 'bg-muted-foreground/30',
      label: 'Not ready',
      withOverride: false,
    };
  }
  return {
    className: STATUS_META[outcome.overall_status].railClassName,
    label: outcome.client_decision && outcome.automated_status !== outcome.overall_status
      ? `${STATUS_META[outcome.overall_status].label} (client ${outcome.client_decision})`
      : outcome.overall_status === 'green' && outcome.with_override
        ? 'Green (internal exception)'
        : STATUS_META[outcome.overall_status].label,
    withOverride: Boolean(outcome.with_override),
  };
}

function summarizeBatchOffer(items: ReviewBatchItem[], offer: OfferColumn): BatchOfferSummary {
  const counts = new Map<BatchResultCategoryKey, number>();
  let exceptionCount = 0;

  for (const item of items) {
    const outcome = batchOutcomeForOffer(item, offer);
    const key = batchResultCategoryKey(outcome);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (outcome?.with_override) exceptionCount += 1;
  }

  const categories = BATCH_RESULT_CATEGORIES.flatMap((category) => {
    const count = counts.get(category.key) ?? 0;
    return count > 0 ? [{ ...category, count }] : [];
  });
  const total = items.length;
  const accessibleSummary = categories
    .map((category) => `${category.count} ${category.label} (${formatBatchPercentage(category.count, total)})`)
    .join(', ') || 'No creatives';

  return { offer, categories, total, exceptionCount, accessibleSummary };
}

function batchResultCategoryKey(outcome: OfferOutcome | null): BatchResultCategoryKey {
  if (!outcome || outcome.evaluation_state !== 'evaluated') return 'na';
  return outcome.overall_status ?? 'not-ready';
}

function formatBatchPercentage(count: number, total: number) {
  if (!total) return '0%';
  const percentage = (count / total) * 100;
  const digits = percentage < 10 && percentage % 1 !== 0 ? 1 : 0;
  return `${percentage.toFixed(digits)}%`;
}

function outcomeDetails(outcome: OfferOutcome) {
  const details = outcome.overall_status
    ? [`Overall: ${STATUS_META[outcome.overall_status].label}`]
    : ['Overall result not ready'];
  if (outcome.creative_result) {
    details.push(`Creative: ${STATUS_META[outcome.creative_result].label}`);
  }
  if (outcome.ad_copy_result) {
    details.push(`Copy: ${STATUS_META[outcome.ad_copy_result].label}`);
  }
  if (outcome.with_override) {
    details.push('Approved internal exception applied');
  }
  if (outcome.client_decision) {
    details.push(`Client ${outcome.client_decision}`);
    if (outcome.automated_status && outcome.automated_status !== outcome.overall_status) {
      details.push(`AdChecked: ${STATUS_META[outcome.automated_status].label}`);
    }
  }
  if (
    outcome.overall_status &&
    !outcome.creative_result &&
    !outcome.ad_copy_result
  ) {
    details.push('Source breakdown not available');
  }
  return details.join(' · ');
}

function normalizeStatus(status: unknown): OverallStatus | null {
  if (status === 'green' || status === 'yellow' || status === 'red') {
    return status;
  }
  if (status === 'amber' || status === 'orange') return 'yellow';
  if (status === 'pass') return 'green';
  if (status === 'needs_review') return 'yellow';
  if (status === 'likely_violation') return 'red';
  return null;
}
