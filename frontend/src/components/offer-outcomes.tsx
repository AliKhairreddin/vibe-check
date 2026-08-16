import { ShieldCheck } from 'lucide-react';

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
  amber: {
    label: 'Amber',
    className: 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-300',
    railClassName: 'bg-orange-500 dark:bg-orange-400',
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
  if (offer.offer_id !== 'acp' || !item.result) return null;
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
  className,
  status,
  withOverride = false,
}: {
  className?: string;
  status: OverallStatus | null | undefined;
  withOverride?: boolean;
}) {
  if (!status) return <Badge variant="outline" className={className}>N/A</Badge>;
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn(meta.className, className)}>
      {status === 'green' && withOverride ? 'Green · Exception' : meta.label}
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
      <div className={cn('grid min-w-24 gap-1', compact && 'min-w-0')} title={message}>
        <Badge variant="outline" className="w-fit text-muted-foreground">N/A</Badge>
        {!compact ? <span className="max-w-40 text-xs leading-4 text-muted-foreground">{message}</span> : null}
      </div>
    );
  }

  const compactDetails = compact ? outcomeDetails(outcome) : undefined;

  return (
    <div
      className={cn('grid min-w-24 gap-1', compact && 'min-w-0')}
      title={compactDetails}
    >
      {outcome.overall_status ? (
        <OfferResultBadge
          className="w-fit"
          status={outcome.overall_status}
          withOverride={outcome.with_override}
        />
      ) : (
        <Badge variant="outline" className="w-fit">Not ready</Badge>
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
  const groups = offers.map((offer) => ({
    offer,
    results: items.map((item, index) => {
      const outcome = batchOutcomeForOffer(item, offer);
      return {
        ...railOutcomeMeta(outcome),
        fileName: item.file_name,
        index,
      };
    }),
  }));
  const accessibleLabel = groups
    .map(({ offer, results }) => `${offer.offer_name}: ${historyResultSummary(results)}`)
    .join('; ');

  return (
    <div
      className="grid h-3 w-full min-w-0 overflow-hidden rounded-full bg-muted ring-1 ring-foreground/10"
      style={{
        gridTemplateColumns: `repeat(${Math.max(groups.length, 1)}, minmax(0, 1fr))`,
      }}
      role="img"
      aria-label={`Batch results by offer. Within each offer, creatives are ordered left to right by upload. ${accessibleLabel}`}
      title="Each offer block shows one segment per creative in upload order."
    >
      {groups.map(({ offer, results }, offerIndex) => (
        <span
          key={offer.offer_id}
          className={cn('grid h-full', offerIndex > 0 && 'border-l-2 border-card')}
          style={{
            gridTemplateColumns: `repeat(${Math.max(results.length, 1)}, minmax(0, 1fr))`,
          }}
        >
          {results.length ? results.map((result, itemIndex) => (
            <span
              key={`${offer.offer_id}:${result.index}`}
              aria-hidden="true"
              className={cn(
                'grid h-full min-w-0 place-items-center',
                itemIndex > 0 && results.length <= 12 && 'border-l border-card/60',
                result.className
              )}
              title={`${offer.offer_name} · ${result.fileName}: ${result.label}`}
            >
              {result.withOverride && results.length <= 12 ? (
                <span className="size-1 rounded-full bg-white shadow-sm" />
              ) : null}
            </span>
          )) : <span className="h-full bg-muted-foreground/15" />}
        </span>
      ))}
    </div>
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

export function OfferEligibilityGrid({ offers }: { offers: OfferCatalogItem[] }) {
  const columns = getOfferColumns(offers);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {columns.map((column) => {
        const offer = offers.find((candidate) => candidate.offer_id === column.offer_id);
        const eligible = Boolean(offer?.enabled && offer.configured);
        const message = eligibilityMessage(offer);
        return (
          <div
            key={column.offer_id}
            className={cn(
              'flex items-center justify-between gap-3 rounded-lg border bg-background p-3',
              eligible && 'border-primary/40 bg-primary/5'
            )}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{column.offer_name}</span>
              <span className="block text-xs leading-5 text-muted-foreground">{message}</span>
            </span>
            <Badge variant={eligible ? 'secondary' : 'outline'} className="shrink-0">
              {eligible ? 'Will review' : 'N/A'}
            </Badge>
          </div>
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
    label: outcome.overall_status === 'green' && outcome.with_override
      ? 'Green (internal exception)'
      : STATUS_META[outcome.overall_status].label,
    withOverride: Boolean(outcome.with_override),
  };
}

function historyResultSummary(results: Array<ReturnType<typeof railOutcomeMeta>>) {
  const counts = new Map<string, number>();
  for (const result of results) counts.set(result.label, (counts.get(result.label) ?? 0) + 1);
  return Array.from(counts, ([label, count]) => `${count} ${label}`).join(', ') || 'No creatives';
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
  if (status === 'green' || status === 'amber' || status === 'red') {
    return status;
  }
  if (status === 'yellow' || status === 'orange') return 'amber';
  if (status === 'pass') return 'green';
  if (status === 'needs_review') return 'amber';
  if (status === 'likely_violation') return 'red';
  return null;
}
