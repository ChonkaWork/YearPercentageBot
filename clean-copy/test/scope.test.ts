import { describe, expect, it } from 'vitest';
import { autoCleanScope, scopeCovers } from '../src/core/sites';

describe('auto-clean scope (per site, or all sites)', () => {
  const sites = ['news.example.com', 'docs.example.org'];

  it('runs on the listed sites that are granted, up to the limit', () => {
    expect(autoCleanScope({ sites, allSites: false, granted: ['*://news.example.com/*'], maxSites: 100 })).toEqual({ all: false, hosts: ['news.example.com'] });
    expect(autoCleanScope({ sites, allSites: false, granted: ['*://news.example.com/*', '*://docs.example.org/*'], maxSites: 1 })).toEqual({ all: false, hosts: ['news.example.com'] });
  });

  it('runs everywhere only when "All sites" is on AND access to all sites is granted', () => {
    expect(autoCleanScope({ sites, allSites: true, granted: ['*://*/*'], maxSites: 100 })).toEqual({ all: true, hosts: [] });
    expect(autoCleanScope({ sites, allSites: true, granted: ['*://news.example.com/*'], maxSites: 100 })).toEqual({ all: false, hosts: ['news.example.com'] });
    // All-sites access without the switch (e.g. it's being turned off): the list still works.
    expect(autoCleanScope({ sites, allSites: false, granted: ['*://*/*'], maxSites: 100 })).toEqual({ all: false, hosts: sites });
  });

  it('runs nowhere without Pro, even with "All sites" on (nothing is deleted)', () => {
    expect(autoCleanScope({ sites, allSites: true, granted: ['*://*/*'], maxSites: 0 })).toEqual({ all: false, hosts: [] });
  });

  it('says whether a host is covered', () => {
    expect(scopeCovers({ all: true, hosts: [] }, 'any.example.net')).toBe(true);
    expect(scopeCovers({ all: true, hosts: [] }, null)).toBe(false);
    expect(scopeCovers({ all: false, hosts: ['news.example.com'] }, 'news.example.com')).toBe(true);
    expect(scopeCovers({ all: false, hosts: ['news.example.com'] }, 'example.com')).toBe(false);
  });
});
