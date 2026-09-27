import { describe, expect, it } from 'vitest';
import {
  clampSpeed,
  formatSpeed,
  formatSpeedShort,
  MAX_SPEED,
  MIN_SPEED,
  roundSpeed,
  sameSpeed,
  seekTarget,
  stepSpeed,
  togglePreferred,
} from '../src/core/speed';

describe('speed arithmetic', () => {
  it('has no floating-point drift', () => {
    expect(1.1 + 0.1).not.toBe(1.2); // the problem being solved
    expect(stepSpeed(1.1, 0.1)).toBe(1.2);
    expect(stepSpeed(0.7, 0.1)).toBe(0.8);
    expect(stepSpeed(1.2, -0.1)).toBe(1.1);
    expect(stepSpeed(1.25, 0.05)).toBe(1.3);
  });

  it('stays exact over long runs of steps up and down', () => {
    let speed = 1;
    for (let i = 1; i <= 140; i += 1) {
      speed = stepSpeed(speed, 0.1);
      expect(speed).toBe(Math.min(MAX_SPEED, Number((1 + i * 0.1).toFixed(2))));
    }
    for (let i = 0; i < 150; i += 1) speed = stepSpeed(speed, -0.05);
    expect(speed).toBe(7.5); // 15 − 150 × 0.05
  });

  it('clamps to the range Chrome accepts', () => {
    expect(stepSpeed(0.1, -0.1)).toBe(MIN_SPEED);
    expect(stepSpeed(MIN_SPEED, -0.1)).toBe(MIN_SPEED);
    expect(stepSpeed(MIN_SPEED, 0.1)).toBe(0.16);
    expect(stepSpeed(15.95, 0.1)).toBe(MAX_SPEED);
    expect(clampSpeed(100)).toBe(16);
    expect(clampSpeed(0)).toBe(MIN_SPEED);
    expect(clampSpeed(-3)).toBe(MIN_SPEED);
  });

  it('rounds to hundredths without binary artifacts', () => {
    expect(roundSpeed(1.005)).toBe(1.01);
    expect(roundSpeed(1.2000000000000002)).toBe(1.2);
    expect(roundSpeed(1.333333)).toBe(1.33);
    expect(stepSpeed(1.333, 0.1)).toBe(1.43);
  });

  it('treats non-numbers as 1×', () => {
    expect(clampSpeed(Number.NaN)).toBe(1);
    expect(clampSpeed(Number.POSITIVE_INFINITY)).toBe(1);
    expect(stepSpeed(Number.NaN, 0.1)).toBe(1.1);
    expect(stepSpeed(1, Number.NaN)).toBe(1);
  });

  it('formats with two decimals', () => {
    expect(formatSpeed(1)).toBe('1.00×');
    expect(formatSpeed(1.2)).toBe('1.20×');
    expect(formatSpeed(1.2000000000000002)).toBe('1.20×');
    expect(formatSpeed(MIN_SPEED)).toBe('0.06×');
    expect(formatSpeed(16)).toBe('16.00×');
    expect(formatSpeedShort(1)).toBe('1×');
    expect(formatSpeedShort(1.25)).toBe('1.25×');
    expect(formatSpeedShort(2.5)).toBe('2.5×');
  });

  it('compares speeds', () => {
    expect(sameSpeed(1.2, stepSpeed(1.1, 0.1))).toBe(true);
    expect(sameSpeed(MIN_SPEED, 0.06)).toBe(false);
  });

  it('toggles between 1× and the preferred speed', () => {
    expect(togglePreferred(1, 1.8)).toBe(1.8);
    expect(togglePreferred(1.8, 1.8)).toBe(1);
    expect(togglePreferred(1.5, 1.8)).toBe(1.8);
    expect(togglePreferred(1.8000000000000003, 1.8)).toBe(1);
    expect(togglePreferred(1, 1)).toBe(1);
    expect(togglePreferred(1, 40)).toBe(16);
  });

  it('keeps seeks inside the media', () => {
    expect(seekTarget(30, 10, 60)).toBe(40);
    expect(seekTarget(55, 10, 60)).toBe(60);
    expect(seekTarget(4, -10, 60)).toBe(0);
    expect(seekTarget(30, 10, Number.POSITIVE_INFINITY)).toBe(40);
    expect(seekTarget(30, 10, Number.NaN)).toBe(40);
    expect(seekTarget(Number.NaN, 10, 60)).toBe(10);
  });
});
