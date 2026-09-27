import { describe, expect, it } from 'vitest';
import { detectContent } from '../src/core/detect';

describe('detectContent: errors', () => {
  it.each([
    ['NullPointerException at UserService.java:142', 'Java'],
    [
      'Exception in thread "main" java.lang.IllegalStateException: boom\n\tat com.acme.App.main(App.java:5)',
      'Java',
    ],
    [
      'Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nValueError: invalid literal',
      'Python',
    ],
    [
      "Uncaught TypeError: Cannot read properties of undefined (reading 'map')\n    at render (app.js:14:22)",
      'JavaScript',
    ],
    ['src/index.ts:12:5 - error TS2345: Argument of type string is not assignable', 'TypeScript'],
    ['panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\nmain.main()\n\t/app/main.go:8 +0x1d', 'Go'],
    ["error[E0382]: borrow of moved value: `v`\n --> src/main.rs:4:20", 'Rust'],
  ])('%s', (text, language) => {
    expect(detectContent(text)).toMatchObject({ kind: 'error', language });
  });

  it('detects an error without a known language', () => {
    expect(detectContent('error: failed to push some refs to origin')).toEqual({ kind: 'error', nonLatin: false });
  });

  it('does not treat an article about exceptions as an error', () => {
    const article = [
      'A NullPointerException is one of the most common problems Java developers run into every day.',
      'It happens when code tries to use a reference that points to nothing at all in memory.',
      'Modern Java versions print helpful messages that explain which variable was null.',
      'Using Optional and careful validation at the boundaries prevents most of these issues.',
    ].join('\n');
    expect(detectContent(article).kind).toBe('text');
  });
});

describe('detectContent: code', () => {
  it.each([
    ['public class Main {\n    public static void main(String[] args) {\n        System.out.println("hi");\n    }\n}', 'Java'],
    ['def add(a, b):\n    return a + b\n\nprint(add(1, 2))', 'Python'],
    ['const total = items.reduce((sum, item) => sum + item.price, 0);\nconsole.log(total);', 'JavaScript'],
    ['interface User {\n  id: number;\n  name: string;\n}\nconst users: User[] = [];', 'TypeScript'],
    ['package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}', 'Go'],
    ['SELECT id, name\nFROM users\nWHERE active = 1\nGROUP BY team;', 'SQL'],
    ['fn main() {\n    let mut v = vec![1, 2, 3];\n    println!("{:?}", v);\n}', 'Rust'],
  ])('%s', (text, language) => {
    expect(detectContent(text)).toMatchObject({ kind: 'code', language });
  });

  it('detects JSON', () => {
    expect(detectContent('{\n  "name": "pastebot",\n  "version": "0.1.0"\n}')).toMatchObject({ kind: 'code', language: 'JSON' });
  });

  it('detects a single line of code', () => {
    expect(detectContent('const doubled = values.map((v) => v * 2);').kind).toBe('code');
  });

  it('leaves the language out when unsure', () => {
    expect(detectContent('x = compute(y);\nz = x + 1;').language).toBeUndefined();
  });
});

describe('detectContent: prose and tables', () => {
  it.each([
    'We are hiring a Senior Java Developer to join our payments team in Kyiv.',
    'Our public transport is great. Follow the signs to the station.\nIf you get lost, ask for help.\nReturn tickets are cheaper.',
    'Pros:\n- Fast\n- Cheap\nCons:\n- Loud',
    'I love C++ and Rust -> both are great for systems work.',
    'Posted by @maria\n3 hours ago\nGreat talk, thanks for sharing!',
  ])('prose: %s', (text) => {
    expect(detectContent(text).kind).toBe('text');
  });

  it('detects tab-separated tables', () => {
    expect(detectContent('Plan\tPrice\nFree\t$0\nPro\t$12').kind).toBe('table');
  });

  it('detects markdown tables', () => {
    expect(detectContent('| Plan | Price |\n| --- | --- |\n| Free | $0 |\n| Pro | $12 |').kind).toBe('table');
  });

  it('flags non-Latin content', () => {
    expect(detectContent('Сьогодні ми запускаємо нову версію продукту для всіх користувачів.').nonLatin).toBe(true);
    expect(detectContent('Today we are launching a new version of the product for everyone.').nonLatin).toBe(false);
  });

  it('handles empty input', () => {
    expect(detectContent('')).toEqual({ kind: 'text', nonLatin: false });
  });
});
