import { describe, expect, it } from 'vitest';
import { cleanProse, normalizeBasics, prepareContent } from '../src/core/clean';

describe('normalizeBasics', () => {
  it('normalizes line endings and trims trailing spaces', () => {
    expect(normalizeBasics('a  \r\nb\t \rc')).toBe('a\nb\t\nc');
  });

  it('strips invisible characters but keeps emoji joiners', () => {
    expect(normalizeBasics('he​llo﻿ wo­rld 👨‍👩‍👧')).toBe('hello world 👨‍👩‍👧');
  });

  it('turns non-breaking spaces into regular spaces', () => {
    expect(normalizeBasics('1 299 €')).toBe('1 299 €');
  });

  it('drops leading and trailing blank lines and whitespace-only lines', () => {
    expect(normalizeBasics('\n  \n\t\nHello\n   \nWorld\n\n')).toBe('Hello\n\nWorld');
  });
});

describe('cleanProse', () => {
  it('collapses repeated blank lines', () => {
    expect(cleanProse('One\n\n\n\n\nTwo\n\n\nThree')).toBe('One\n\nTwo\n\nThree');
  });

  it('removes consecutive duplicated lines', () => {
    const text = 'Posted by Maria Hernandez\nPosted by Maria Hernandez\nThe release is scheduled for Friday.';
    expect(cleanProse(text)).toBe('Posted by Maria Hernandez\nThe release is scheduled for Friday.');
  });

  it('removes duplicates separated by blank lines', () => {
    expect(cleanProse('How to configure logging\n\nHow to configure logging\n\nStep one.')).toBe(
      'How to configure logging\n\nStep one.',
    );
  });

  it('keeps short repeated lines, they are often legitimate', () => {
    expect(cleanProse('Yes\nYes\nNo')).toBe('Yes\nYes\nNo');
  });

  it('removes obvious UI noise lines', () => {
    const text = 'Skip to main content\nThe new API is faster.\nShare\nIt also uses less memory.\nRead more…\nReply';
    expect(cleanProse(text)).toBe('The new API is faster.\nIt also uses less memory.');
  });

  it('keeps UI words when they are the whole selection', () => {
    expect(cleanProse('Share')).toBe('Share');
    expect(cleanProse('Share\nFollow')).toBe('Share\nFollow');
  });

  it('keeps UI words inside sentences', () => {
    const text = 'Please share the report.\nLike most teams, we follow up weekly.\nReply by Friday.';
    expect(cleanProse(text)).toBe(text);
  });

  it('collapses sporadic double spaces', () => {
    const text = 'This sentence  has a stray gap.\nThis one is fine.\nSo is this.\nAnd this.\nAnd this one.\nLast line.';
    expect(cleanProse(text)).toContain('This sentence has a stray gap.');
  });

  it('keeps systematic alignment (CLI output)', () => {
    const text = 'Filesystem      Size  Used Avail\n/dev/sda1        50G   20G   30G\ntmpfs           2.0G     0  2.0G';
    expect(cleanProse(text)).toBe(text);
  });
});

describe('prepareContent', () => {
  it('keeps code blank lines and indentation, removes common indentation', () => {
    const code = '        if (a) {\n            run();\n        }\n\n\n\n\n        done();';
    const { text, info } = prepareContent(code);
    expect(info.kind).toBe('code');
    // Four blank lines collapse to two.
    expect(text).toBe('if (a) {\n    run();\n}\n\n\ndone();');
  });

  it('does not dedupe repeated code lines', () => {
    const code = 'function a() {\n  if (x) {\n    return 1;\n  }\n}\n}';
    expect(prepareContent(code).text).toBe(code);
  });

  it('does not remove UI-looking words from code', () => {
    const code = 'switch (action) {\n  case "share":\n    share();\n    break;\n}';
    expect(prepareContent(code).text).toBe(code);
  });

  it('strips UI labels around code but never single words inside it', () => {
    const selection = 'Copy code\nconst a = 1;\nShare\nconst b = a + 1;\nCopy code\nconsole.log(b);\nShare\nFollow';
    expect(prepareContent(selection).text).toBe('const a = 1;\nShare\nconst b = a + 1;\nconsole.log(b);');
  });

  it('keeps stack trace frames even when they repeat', () => {
    const trace = [
      'java.lang.StackOverflowError',
      '    at com.example.Node.depth(Node.java:10)',
      '    at com.example.Node.depth(Node.java:10)',
      '    at com.example.Node.depth(Node.java:10)',
    ].join('\n');
    const { text, info } = prepareContent(trace);
    expect(info.kind).toBe('error');
    expect(text).toBe(trace);
  });

  it('keeps identical table rows (they can be real data)', () => {
    const table = 'Date\tAmount\n2024-01-01\t$10.00 coffee beans\n2024-01-01\t$10.00 coffee beans';
    expect(prepareContent(table).text).toBe(table);
  });
});
