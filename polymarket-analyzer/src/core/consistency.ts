import type { MarketEvent } from './types';

/**
 * Extension point (prepared, not built): consistency checks across related markets.
 *
 * Related markets constrain each other. Examples a future check could flag, purely as data
 * observations and never as "mispricing" or an arbitrage opportunity:
 *   - date ladders: "X by March" priced above "X by June"
 *   - threshold ladders: "BTC above $120k" priced above "BTC above $100k"
 *   - winner-takes-all events whose prices add up far from 100%
 *
 * A check receives the normalized event (never raw API data) and returns findings. The
 * registry is empty in the MVP, so `runConsistencyChecks` returns nothing and the UI shows
 * nothing.
 */

export interface ConsistencyFinding {
  checkId: string;
  severity: 'info' | 'warning';
  /** Short, factual description with the numbers involved. */
  message: string;
  marketSlugs: string[];
}

export interface ConsistencyCheck {
  readonly id: string;
  appliesTo(event: MarketEvent): boolean;
  run(event: MarketEvent): ConsistencyFinding[];
}

const registry: ConsistencyCheck[] = [];

export function registerConsistencyCheck(check: ConsistencyCheck): () => void {
  registry.push(check);
  return () => {
    const index = registry.indexOf(check);
    if (index >= 0) registry.splice(index, 1);
  };
}

export function runConsistencyChecks(event: MarketEvent): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  for (const check of registry) {
    try {
      if (check.appliesTo(event)) findings.push(...check.run(event));
    } catch {
      // A broken check must never break the analysis.
    }
  }
  return findings;
}
