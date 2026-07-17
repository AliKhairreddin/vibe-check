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

const STATUS_META: Record<OverallStatus, { label: string; className: string }> = {
  green: {
    label: 'Green',
    className: 'border-emerald-600/30 bg-emerald-500/15 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/15 dark:text-emerald-300',
  },
  yellow: {
    label: 'Yellow',
    className: 'border-yellow-600/30 bg-yellow-400/20 text-yellow-800 dark:border-yellow-400/30 dark:bg-yellow-400/15 dark:text-yellow-200',
  },
  orange: {
    label: 'Orange',
    className: 'border-orange-600/30 bg-orange-500/15 text-orange-700 dark:border-orange-400/30 dark:bg-orange-400/15 dark:text-orange-300',
  },
  red: {
    label: 'Red',
    className: 'border-red-600/30 bg-red-500/15 text-red-700 dark:border-red-400/30 dark:bg-red-400/15 dark:text-red-300',
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
}: {
  className?: string;
  status: OverallStatus | null | undefined;
}) {
  if (!status) return <Badge variant="outline" className={className}>N/A</Badge>;
  const meta = STATUS_META[status];
  return (
    <Badge variant="outline" className={cn(meta.className, className)}>
      {meta.label}
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

  return (
    <div className={cn('grid min-w-24 gap-1', compact && 'min-w-0')}>
      {outcome.overall_status ? (
        <OfferResultBadge className="w-fit" status={outcome.overall_status} />
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
  return `Guidelines v${offer.version} · ${offer.override_count} overrides`;
}

function unavailableMessage(state: OfferOutcome['evaluation_state'] | undefined) {
  if (state === 'disabled') return 'Offer was turned off for this review.';
  if (state === 'missing_guidelines') return 'No guidelines were available for this review.';
  return 'No offer result was saved for this review.';
}

function normalizeStatus(status: unknown): OverallStatus | null {
  if (status === 'green' || status === 'yellow' || status === 'orange' || status === 'red') {
    return status;
  }
  if (status === 'pass') return 'green';
  if (status === 'needs_review') return 'orange';
  if (status === 'likely_violation') return 'red';
  return null;
}
