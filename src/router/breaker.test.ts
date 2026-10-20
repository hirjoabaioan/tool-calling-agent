import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './breaker.js';

function make() {
  let t = 1_000_000;
  const breaker = new CircuitBreaker({ now: () => t });
  return { breaker, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold', () => {
    const { breaker } = make();
    breaker.recordFailure('p');
    breaker.recordFailure('p');
    expect(breaker.state('p')).toBe('closed');
    expect(breaker.allow('p')).toBe(true);
  });

  it('opens after 3 failures within 60s and skips the provider', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('p');
      advance(10_000);
    }
    expect(breaker.state('p')).toBe('open');
    expect(breaker.allow('p')).toBe(false);
    expect(breaker.allow('other')).toBe(true);
  });

  it('does not open when failures are spread beyond the window', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('p');
      advance(40_000);
    }
    expect(breaker.state('p')).toBe('closed');
  });

  it('goes half-open after 120s and admits exactly one probe', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure('p');
    advance(119_999);
    expect(breaker.state('p')).toBe('open');
    advance(1);
    expect(breaker.state('p')).toBe('half_open');
    expect(breaker.allow('p')).toBe(true);
    expect(breaker.allow('p')).toBe(false);
  });

  it('closes again after a successful probe', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure('p');
    advance(120_000);
    breaker.allow('p');
    breaker.recordSuccess('p');
    expect(breaker.state('p')).toBe('closed');
    expect(breaker.allow('p')).toBe(true);
  });

  it('re-opens for another full cool-down after a failed probe', () => {
    const { breaker, advance } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure('p');
    advance(120_000);
    breaker.allow('p');
    breaker.recordFailure('p');
    expect(breaker.state('p')).toBe('open');
    advance(119_999);
    expect(breaker.state('p')).toBe('open');
    advance(1);
    expect(breaker.state('p')).toBe('half_open');
  });
});
