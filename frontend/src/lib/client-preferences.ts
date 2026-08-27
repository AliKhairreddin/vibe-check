import type { OverallStatus } from '@/lib/api';

export type ClientReviewDensity = 'comfortable' | 'compact';
export type ClientReviewView = 'grid' | 'list';
export type ClientDefaultResultFilter = 'all' | OverallStatus;

export type ClientPreferences = {
  autoExpandNewestBatch: boolean;
  defaultResultFilter: ClientDefaultResultFilter;
  density: ClientReviewDensity;
  reviewView: ClientReviewView;
};

const CLIENT_PREFERENCES_KEY = 'adchecked-client-preferences-v1';

export const DEFAULT_CLIENT_PREFERENCES: ClientPreferences = {
  autoExpandNewestBatch: true,
  defaultResultFilter: 'all',
  density: 'comfortable',
  reviewView: 'grid',
};

export function readClientPreferences(): ClientPreferences {
  if (typeof window === 'undefined') return DEFAULT_CLIENT_PREFERENCES;
  try {
    const value = JSON.parse(window.localStorage.getItem(CLIENT_PREFERENCES_KEY) ?? '{}') as Partial<ClientPreferences>;
    return {
      autoExpandNewestBatch: typeof value.autoExpandNewestBatch === 'boolean'
        ? value.autoExpandNewestBatch
        : DEFAULT_CLIENT_PREFERENCES.autoExpandNewestBatch,
      defaultResultFilter: value.defaultResultFilter === 'green'
        || value.defaultResultFilter === 'yellow'
        || value.defaultResultFilter === 'red'
        || value.defaultResultFilter === 'all'
        ? value.defaultResultFilter
        : DEFAULT_CLIENT_PREFERENCES.defaultResultFilter,
      density: value.density === 'compact' || value.density === 'comfortable'
        ? value.density
        : DEFAULT_CLIENT_PREFERENCES.density,
      reviewView: value.reviewView === 'list' || value.reviewView === 'grid'
        ? value.reviewView
        : DEFAULT_CLIENT_PREFERENCES.reviewView,
    };
  } catch {
    return DEFAULT_CLIENT_PREFERENCES;
  }
}

export function saveClientPreferences(preferences: ClientPreferences) {
  window.localStorage.setItem(CLIENT_PREFERENCES_KEY, JSON.stringify(preferences));
}

export function resetClientPreferences() {
  window.localStorage.removeItem(CLIENT_PREFERENCES_KEY);
  return DEFAULT_CLIENT_PREFERENCES;
}
