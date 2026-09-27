import { describe, expect, it } from 'vitest';
import { checkOutcomeSum, highestPriced, normalizeChange, normalizeProbability, sortByProbability } from '../src/core/probability';

describe('probability normalization', () => {
  it('accepts [0, 1] numbers and numeric strings, never rescales', () => {
    expect(normalizeProbability('0.535')).toBe(0.535);
    expect(normalizeProbability(0)).toBe(0);
    expect(normalizeProbability(1)).toBe(1);
    expect(normalizeProbability(1.0000001)).toBe(1);
    expect(normalizeProbability(-0.0000001)).toBe(0);
    expect(normalizeProbability(62)).toBeNull();
    expect(normalizeProbability('1.7')).toBeNull();
    expect(normalizeProbability(-0.2)).toBeNull();
    expect(normalizeProbability('abc')).toBeNull();
    expect(normalizeProbability(NaN)).toBeNull();
  });

  it('changes must be within [-1, 1]', () => {
    expect(normalizeChange(-0.075)).toBe(-0.075);
    expect(normalizeChange('0.031')).toBe(0.031);
    expect(normalizeChange(3.1)).toBeNull();
    expect(normalizeChange(undefined)).toBeNull();
  });
});

describe('outcome sum sanity', () => {
  it('classifies sums of mutually exclusive outcomes', () => {
    expect(checkOutcomeSum([0.62, 0.38], true)).toEqual({ status: 'ok', sum: 1 });
    expect(checkOutcomeSum([0.06, 0.235, 0.41, 0.205, 0.075], true).status).toBe('ok');
    expect(checkOutcomeSum([0.6, 0.47], true).status).toBe('spread');
    expect(checkOutcomeSum([0.3, 0.3], true).status).toBe('inconsistent');
    expect(checkOutcomeSum([0.9, 0.9], true).status).toBe('inconsistent');
    expect(checkOutcomeSum([0.5, null], true)).toEqual({ status: 'incomplete', sum: null });
    expect(checkOutcomeSum([0.9, 0.9], false).status).toBe('not-applicable');
    expect(checkOutcomeSum([0.9], true).status).toBe('not-applicable');
  });
});

describe('leader and ordering', () => {
  const items = [
    { id: 'a', probability: 0.2 },
    { id: 'b', probability: null },
    { id: 'c', probability: 0.41 },
    { id: 'd', probability: 0.41 },
  ];

  it('highest-priced outcome keeps the first of equal prices and skips unknowns', () => {
    expect(highestPriced(items)?.id).toBe('c');
    expect(highestPriced([{ probability: null }])).toBeNull();
  });

  it('sorts by probability, unknown prices last, stable for ties', () => {
    expect(sortByProbability(items).map((item) => item.id)).toEqual(['c', 'd', 'a', 'b']);
  });
});
