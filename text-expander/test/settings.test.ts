import { describe, expect, it } from 'vitest';
import { isExpandableField, isSensitiveAutocomplete } from '../src/core/fields';
import {
  addDisabledSite,
  defaultSettings,
  findDisablingEntry,
  hostMatches,
  MAX_DISABLED_SITES,
  normalizeHostname,
  removeDisabledSitesFor,
  sanitizeSettings,
} from '../src/core/settings';

describe('sanitizeSettings', () => {
  it('returns defaults for garbage', () => {
    for (const raw of [undefined, null, 42, 'x', [], {}]) expect(sanitizeSettings(raw)).toEqual(defaultSettings());
  });

  it('keeps valid values and normalizes the site list', () => {
    expect(
      sanitizeSettings({ triggerMode: 'delimiter', disabledSites: ['Example.com', 'https://mail.example.com/x', 'example.com', 7, 'not a host', ''] }),
    ).toEqual({ triggerMode: 'delimiter', disabledSites: ['example.com', 'mail.example.com'] });
    expect(sanitizeSettings({ triggerMode: 'sometimes' }).triggerMode).toBe('immediate');
  });

  it('caps the site list', () => {
    const sites = Array.from({ length: MAX_DISABLED_SITES + 10 }, (_, i) => `site${i}.com`);
    expect(sanitizeSettings({ disabledSites: sites }).disabledSites).toHaveLength(MAX_DISABLED_SITES);
  });
});

describe('normalizeHostname', () => {
  it('accepts hosts, URLs, wildcards and ports', () => {
    expect(normalizeHostname('Example.COM')).toBe('example.com');
    expect(normalizeHostname(' https://www.example.com/path?q=1 ')).toBe('www.example.com');
    expect(normalizeHostname('*.example.com')).toBe('example.com');
    expect(normalizeHostname('example.com:8080')).toBe('example.com');
    expect(normalizeHostname('localhost')).toBe('localhost');
    expect(normalizeHostname('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHostname('[::1]')).toBe('[::1]');
    expect(normalizeHostname('münchen.de')).toBe('xn--mnchen-3ya.de');
    expect(normalizeHostname('example.com.')).toBe('example.com');
  });

  it('rejects things that are not web hosts', () => {
    for (const bad of ['', '   ', 'not a host', 'ftp://example.com', 'chrome://settings', 'user:pw@example.com', 'exa_mple.com', 'a'.repeat(260)]) {
      expect(normalizeHostname(bad)).toBe(null);
    }
  });
});

describe('site matching', () => {
  it('covers subdomains but not look-alikes', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('mail.example.com', 'example.com')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com', 'mail.example.com')).toBe(false);
  });

  it('checks a frame and the pages it is embedded in', () => {
    expect(findDisablingEntry(['editor.cdn.net', 'docs.example.com'], ['example.com'])).toBe('example.com');
    expect(findDisablingEntry(['editor.cdn.net', ''], ['example.com'])).toBe(null);
    expect(findDisablingEntry([''], [])).toBe(null);
  });

  it('adds and removes entries', () => {
    expect(addDisabledSite([], 'https://Example.com/')).toEqual(['example.com']);
    expect(addDisabledSite(['example.com'], 'example.com')).toEqual(['example.com']);
    expect(addDisabledSite(['example.com'], 'bad host')).toEqual(['example.com']);
    // Re-enabling a subdomain removes the parent-domain entry that covered it.
    expect(removeDisabledSitesFor(['example.com', 'mail.example.com', 'other.org'], 'mail.example.com')).toEqual(['other.org']);
  });
});

describe('field eligibility', () => {
  it('allows free-text inputs and textareas', () => {
    for (const type of ['text', 'search', 'email', 'url', 'tel']) expect(isExpandableField({ tag: 'input', type })).toBe(true);
    expect(isExpandableField({ tag: 'textarea' })).toBe(true);
    expect(isExpandableField({ tag: 'input' })).toBe(true);
  });

  it('never touches passwords, numbers, read-only or disabled fields', () => {
    for (const type of ['password', 'number', 'date', 'hidden', 'checkbox', 'file']) expect(isExpandableField({ tag: 'input', type })).toBe(false);
    expect(isExpandableField({ tag: 'input', type: 'text', readOnly: true })).toBe(false);
    expect(isExpandableField({ tag: 'textarea', disabled: true })).toBe(false);
    expect(isExpandableField({ tag: 'select' })).toBe(false);
  });

  it('never touches one-time codes, card fields or revealed passwords', () => {
    expect(isSensitiveAutocomplete('one-time-code')).toBe(true);
    expect(isSensitiveAutocomplete('cc-number')).toBe(true);
    expect(isSensitiveAutocomplete('section-pay billing CC-CSC')).toBe(true);
    expect(isSensitiveAutocomplete('current-password')).toBe(true);
    expect(isSensitiveAutocomplete('new-password')).toBe(true);
    expect(isSensitiveAutocomplete('email')).toBe(false);
    expect(isSensitiveAutocomplete('off')).toBe(false);
    expect(isSensitiveAutocomplete(null)).toBe(false);
    expect(isExpandableField({ tag: 'input', type: 'text', autocomplete: 'one-time-code' })).toBe(false);
    expect(isExpandableField({ tag: 'textarea', autocomplete: 'cc-name' })).toBe(false);
  });
});
