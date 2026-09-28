import { describe, expect, it } from 'vitest';
import {
  addChannel,
  channelFromHref,
  channelLabel,
  findChannel,
  isAllowed,
  normalizeHandle,
  parseChannelInput,
  removeChannel,
  sameChannel,
  sanitizeAllowlist,
  type AllowedChannel,
} from '../src/core/channels';

const ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const OTHER_ID = 'UCBJycsmduvYEL83R_U4JriQ';

describe('normalizeHandle', () => {
  it('adds @, lower-cases, accepts dots, dashes, underscores and non-Latin letters', () => {
    expect(normalizeHandle('CalmCoding')).toBe('@calmcoding');
    expect(normalizeHandle('@Calm.Coding-TV_1')).toBe('@calm.coding-tv_1');
    expect(normalizeHandle('@КаналПро')).toBe('@каналпро');
    expect(normalizeHandle('%40caf%C3%A9tv')).toBe('@cafétv');
  });

  it('rejects too short, too long and odd characters', () => {
    expect(normalizeHandle('@ab')).toBeNull();
    expect(normalizeHandle(`@${'a'.repeat(31)}`)).toBeNull();
    expect(normalizeHandle('@calm coding')).toBeNull();
    expect(normalizeHandle('@calm/coding')).toBeNull();
    expect(normalizeHandle('%E0%A4%A')).toBeNull();
  });
});

describe('channelFromHref', () => {
  it('reads handle and id links, relative or absolute, www. or m.', () => {
    expect(channelFromHref('/@CalmCoding')).toEqual({ id: null, handle: '@calmcoding' });
    expect(channelFromHref('/@CalmCoding/videos?view=0')).toEqual({ id: null, handle: '@calmcoding' });
    expect(channelFromHref(`/channel/${ID}`)).toEqual({ id: ID, handle: null });
    expect(channelFromHref(`https://www.youtube.com/channel/${ID}/featured`)).toEqual({ id: ID, handle: null });
    expect(channelFromHref('https://m.youtube.com/@calmcoding')).toEqual({ id: null, handle: '@calmcoding' });
    expect(channelFromHref('//www.youtube.com/@calmcoding')).toEqual({ id: null, handle: '@calmcoding' });
  });

  it('ignores other links and other hosts', () => {
    expect(channelFromHref('/watch?v=abc')).toBeNull();
    expect(channelFromHref('/c/LegacyName')).toBeNull();
    expect(channelFromHref('/channel/not-an-id')).toBeNull();
    expect(channelFromHref('https://example.com/@calmcoding')).toBeNull();
    expect(channelFromHref('https://youtube.com.evil.test/@calmcoding')).toBeNull();
    expect(channelFromHref('')).toBeNull();
  });
});

describe('parseChannelInput', () => {
  it('accepts handles, ids and URLs', () => {
    expect(parseChannelInput('@CalmCoding')).toEqual({ id: null, handle: '@calmcoding' });
    expect(parseChannelInput(' calmcoding ')).toEqual({ id: null, handle: '@calmcoding' });
    expect(parseChannelInput(ID)).toEqual({ id: ID, handle: null });
    expect(parseChannelInput('https://www.youtube.com/@CalmCoding/videos')).toEqual({ id: null, handle: '@calmcoding' });
    expect(parseChannelInput('youtube.com/@calmcoding')).toEqual({ id: null, handle: '@calmcoding' });
    expect(parseChannelInput(`m.youtube.com/channel/${ID}`)).toEqual({ id: ID, handle: null });
  });

  it('rejects everything else', () => {
    for (const bad of ['', '   ', 'calm coding', 'https://www.youtube.com/watch?v=abc', 'https://vimeo.com/@calm', 'a/b', '@x']) {
      expect(parseChannelInput(bad)).toBeNull();
    }
  });
});

describe('list operations', () => {
  const calm: AllowedChannel = { id: null, handle: '@calmcoding', name: 'Calm Coding' };

  it('matches by id or by handle', () => {
    expect(sameChannel({ id: ID, handle: null }, { id: ID, handle: '@x-y-z' })).toBe(true);
    expect(sameChannel({ id: null, handle: '@calmcoding' }, { id: OTHER_ID, handle: '@calmcoding' })).toBe(true);
    expect(sameChannel({ id: ID, handle: null }, { id: null, handle: '@calmcoding' })).toBe(false);
    expect(sameChannel({ id: null, handle: null }, { id: null, handle: null })).toBe(false);
    expect(findChannel([calm], { id: OTHER_ID, handle: '@calmcoding' })).toBe(calm);
    expect(findChannel([calm], null)).toBeNull();
  });

  it('isAllowed honors the limit (entries beyond it are kept but not applied)', () => {
    const list = [{ id: OTHER_ID, handle: null, name: 'A' }, calm];
    expect(isAllowed(list, { id: null, handle: '@calmcoding' })).toBe(true);
    expect(isAllowed(list, { id: null, handle: '@calmcoding' }, 1)).toBe(false);
    expect(isAllowed(list, { id: null, handle: '@calmcoding' }, 0)).toBe(false);
  });

  it('adds with a name (or the handle), completes existing entries, respects max', () => {
    let list = addChannel([], { id: null, handle: '@calmcoding' });
    expect(list).toEqual([{ id: null, handle: '@calmcoding', name: '@calmcoding' }]);
    list = addChannel(list, { id: ID, handle: '@calmcoding' }, '  Calm   Coding ');
    expect(list).toEqual([{ id: ID, handle: '@calmcoding', name: 'Calm Coding' }]);
    expect(addChannel(list, { id: ID, handle: null })).toEqual(list);
    expect(addChannel(list, { id: OTHER_ID, handle: null }, 'Other', 1)).toEqual(list);
    expect(addChannel(list, { id: OTHER_ID, handle: null }, 'Other')).toHaveLength(2);
  });

  it('removes by id or handle', () => {
    const list = [{ id: ID, handle: '@calmcoding', name: 'Calm' }, { id: OTHER_ID, handle: null, name: 'Other' }];
    expect(removeChannel(list, { id: null, handle: '@calmcoding' })).toEqual([list[1]]);
    expect(removeChannel(list, { id: OTHER_ID, handle: null })).toEqual([list[0]]);
  });

  it('labels with the handle, else the id', () => {
    expect(channelLabel({ id: ID, handle: '@calmcoding' })).toBe('@calmcoding');
    expect(channelLabel({ id: ID, handle: null })).toBe(ID);
  });
});

describe('sanitizeAllowlist', () => {
  it('drops junk, normalizes, merges duplicates and caps the length', () => {
    const raw = [
      null,
      'string',
      { handle: '@CalmCoding', name: 'Calm Coding' },
      { id: ID, handle: 'calmcoding' },
      { id: 'bad', handle: '@x' },
      { id: OTHER_ID, name: 42 },
      { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', handle: null, name: 'Third' },
    ];
    expect(sanitizeAllowlist(raw, 10)).toEqual([
      { id: ID, handle: '@calmcoding', name: 'Calm Coding' },
      { id: OTHER_ID, handle: null, name: OTHER_ID },
      { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', handle: null, name: 'Third' },
    ]);
    expect(sanitizeAllowlist(raw, 1)).toHaveLength(1);
    expect(sanitizeAllowlist('nope', 10)).toEqual([]);
  });
});
