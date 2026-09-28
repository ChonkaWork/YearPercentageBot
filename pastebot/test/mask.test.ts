import { describe, expect, it } from 'vitest';
import { MASK_CATEGORIES, Masker, isValidIban, maskSecrets, maskSummary, passesLuhn, type MaskCategory } from '../src/core/mask';

// Provider-shaped keys are assembled at runtime so secret scanners don't flag this file. None of
// them is real.
const join = (...parts: string[]) => parts.join('');
const OPENAI = join('sk-', 'proj-', 'Xq7LmN2pR8sT4vW9yZ1aB3cD5eF6gH0jK2lM4nP9fQ2');
const OPENAI_LEGACY = join('sk-', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4');
const ANTHROPIC = join('sk-', 'ant-api03-', 'Zx8Yw7Vu6Ts5Rq4Po3Nm2Lk1Jh0GfEdCbA9z8y7x6w');
const AWS = join('AKIA', 'IOSFODNN7EXAMPLE');
const GITHUB = join('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');
const GITHUB_FINE = join('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
const STRIPE = join('sk_', 'live_', '51H8xYzAbCdEfGh12345678');
const STRIPE_RESTRICTED = join('rk_', 'live_', '51H8xYzAbCdEfGh87654321');
const SLACK = join('xoxb-', '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx');
const GOOGLE = join('AIza', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q');
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PRIVATE_KEY = [
  join('-----BEGIN RSA ', 'PRIVATE KEY-----'),
  'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB',
  'aFDrBz9vFqU4yQ6E1NcqV8fJ2VqyCZ0mUvBW0sDOv9Yk0BtfQ3sLr5FGtPq+8xHk',
  join('-----END RSA ', 'PRIVATE KEY-----'),
].join('\n');

function masked(text: string, off: MaskCategory[] = []) {
  return maskSecrets(text, { off });
}

function categories(text: string): MaskCategory[] {
  return masked(text).items.map((item) => item.category);
}

/** Text that must come out exactly as it went in. */
function untouched(text: string) {
  const result = masked(text);
  expect(result.items).toEqual([]);
  expect(result.text).toBe(text);
}

describe('mask: API keys and tokens', () => {
  it.each([
    ['OpenAI project key', OPENAI, 'sk-proj-…9fQ2'],
    ['OpenAI legacy key', OPENAI_LEGACY, 'sk-…W3x4'],
    ['Anthropic key', ANTHROPIC, 'sk-ant-…x6w'.replace('x6w', '7x6w')],
    ['AWS access key id', AWS, 'AKIA…MPLE'],
    ['GitHub token', GITHUB, 'ghp_…q7R8'],
    ['GitHub fine-grained token', GITHUB_FINE, 'github_pat_…CDEF'],
    ['Stripe secret key', STRIPE, 'sk_live_…5678'],
    ['Stripe restricted key', STRIPE_RESTRICTED, 'rk_live_…4321'],
    ['Slack bot token', SLACK, 'xoxb-…UvWx'],
    ['Google API key', GOOGLE, 'AIza…O5p6Q'.replace('O5p6Q', '5p6Q')],
  ])('%s', (_name, key, preview) => {
    const result = masked(`export OPENAI_KEY_FOR_TESTS="${key}" # rotate me`);
    expect(result.text).toBe('export OPENAI_KEY_FOR_TESTS="[API_KEY_1]" # rotate me');
    expect(result.items).toEqual([{ category: 'apiKey', placeholder: '[API_KEY_1]', preview, count: 1 }]);
  });

  it('masks a Bearer token but keeps the scheme', () => {
    const result = masked('curl -H "Authorization: Bearer 8f3a9c2e71b04d6fa5e2c9b1d7e3f601" https://api.example.com/v1/me');
    expect(result.text).toBe('curl -H "Authorization: Bearer [TOKEN_1]" https://api.example.com/v1/me');
    expect(result.items[0]).toMatchObject({ category: 'apiKey', preview: 'Bearer …f601' });
  });

  it('prefers the JWT placeholder for a Bearer JWT', () => {
    expect(masked(`Authorization: Bearer ${JWT}`).text).toBe('Authorization: Bearer [JWT_1]');
  });

  it('masks Basic credentials after Authorization', () => {
    expect(masked('Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l1').text).toBe('Authorization: Basic [TOKEN_1]');
  });

  it('leaves identifiers, CSS classes and prose that look a bit like keys alone', () => {
    untouched('const AKIA_PREFIX = "AKIA"; function getApiKey() { return process.env.API_KEY; }');
    untouched('<div class="sk-fading-circle sk-circle-bounce-delay-animation"></div>');
    untouched('We use a bearer token in the Authorization header.');
    untouched('Use sk_live_ keys only on the server.');
    untouched('The task-scheduler-with-long-name-here runs nightly.');
  });
});

describe('mask: JWTs and private keys', () => {
  it('masks a JWT with a readable preview', () => {
    const result = masked(`token: ${JWT}`);
    expect(result.text).toBe('token: [JWT_1]');
    expect(result.items).toEqual([{ category: 'jwt', placeholder: '[JWT_1]', preview: 'eyJ…sw5c', count: 1 }]);
  });

  it('masks a whole private key block', () => {
    const result = masked(`key.pem:\n${PRIVATE_KEY}\nend of file`);
    expect(result.text).toBe('key.pem:\n[PRIVATE_KEY_1]\nend of file');
    expect(result.items[0]).toMatchObject({ category: 'privateKey', preview: 'RSA private key' });
  });

  it('masks a private key cut off by the selection', () => {
    const cut = PRIVATE_KEY.split('\n').slice(0, 3).join('\n');
    expect(masked(`${cut}\n\nNext paragraph stays.`).text).toBe('[PRIVATE_KEY_1]\n\nNext paragraph stays.');
  });

  it('leaves public keys and certificates alone', () => {
    untouched('-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----');
  });
});

describe('mask: secrets in URLs, logs and config', () => {
  it.each([
    ['query string', 'GET /v1/charges?limit=10&api_key=9f8e7d6c5b4a&expand=customer', 'GET /v1/charges?limit=10&api_key=[SECRET_1]&expand=customer'],
    ['logfmt', 'level=info user=anna password=hunter2 status=ok', 'level=info user=anna password=[SECRET_1] status=ok'],
    ['env file', 'DATABASE_PASSWORD=Pr0d-Db!2026\nPORT=5432', 'DATABASE_PASSWORD=[SECRET_1]\nPORT=5432'],
    ['JSON', '{"client_secret": "abcDEF123456", "scope": "read"}', '{"client_secret": "[SECRET_1]", "scope": "read"}'],
    ['YAML', 'redis:\n  password: S3cr3t-2026\n  port: 6379', 'redis:\n  password: [SECRET_1]\n  port: 6379'],
    ['code literal', 'const password = "correct horse";', 'const password = "[SECRET_1]";'],
    ['header', 'X-Api-Key: 5f4dcc3b5aa765d61d8327deb882cf99', 'X-Api-Key: [SECRET_1]'],
    ['cookie', 'Set-Cookie: session_id=a8f5f167f44f4964e6c998dee827110c; Path=/', 'Set-Cookie: session_id=[SECRET_1]; Path=/'],
    ['URL password', 'postgres://admin:s3cr3t@db.internal:5432/app', 'postgres://admin:[SECRET_1]@db.internal:5432/app'],
    ['AWS secret key', 'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'aws_secret_access_key = [SECRET_1]'],
  ])('%s', (_name, input, output) => {
    const result = masked(input);
    expect(result.text).toBe(output);
    expect(result.items.map((item) => item.category)).toEqual(['secret']);
  });

  it('shows the key name, never the value, in the preview', () => {
    expect(masked('password=hunter2').items[0]?.preview).toBe('password=…');
    expect(masked('token=abcdefghijklmnop1234').items[0]?.preview).toBe('token=…1234');
    expect(masked('mongodb://root:pa55word@mongo:27017').items[0]?.preview).toBe('mongodb://root:…@');
  });

  it('leaves code, counters and stand-ins alone', () => {
    untouched('const token = getToken(); const password = this.password;');
    untouched('{ token: token, password: hashedPassword }');
    untouched('usage: prompt_tokens=1234 completion_tokens=56 max_tokens=4096');
    untouched('password_hash=$2b$12$abc and passwordField=visible');
    untouched('DB_PASSWORD=${DB_PASSWORD} TOKEN=<your token> SECRET=**** API_KEY=changeme');
    untouched('password: ""');
    untouched('"password": "must be at least 8 characters long"');
    untouched('The token: expired, refresh it.');
  });
});

describe('mask: emails', () => {
  it('masks addresses and keeps the domain in the preview', () => {
    const result = masked('Contact anna.kowalski+billing@example.co.uk or ops@example.com.');
    expect(result.text).toBe('Contact [EMAIL_1] or [EMAIL_2].');
    expect(result.items.map((item) => item.preview)).toEqual(['a…@example.co.uk', 'o…@example.com']);
  });

  it('gives the same address the same placeholder, case-insensitively', () => {
    const result = masked('From: Anna@Example.com\nTo: team@example.com\nCc: anna@example.com');
    expect(result.text).toBe('From: [EMAIL_1]\nTo: [EMAIL_2]\nCc: [EMAIL_1]');
    expect(result.items[0]?.count).toBe(2);
  });

  it('leaves retina images, package versions and git remotes alone', () => {
    untouched('<img src="logo@2x.png"> and icon@3x.webp');
    untouched('npm install @babel/core@7.24.0 react@18.3.1');
    untouched('git clone git@github.com:acme/shop.git');
  });
});

describe('mask: phone numbers', () => {
  it.each([
    '+1 (415) 555-0132',
    '+44 20 7946 0958',
    '+380 67 123 4567',
    '+14155550132',
    '(415) 555-0132',
    '415-555-0132',
    '415.555.0132',
  ])('%s', (phone) => {
    const result = masked(`Call ${phone} today`);
    expect(result.text).toBe('Call [PHONE_1] today');
    expect(result.items[0]?.category).toBe('phone');
  });

  it('masks labelled numbers in local formats', () => {
    expect(masked('Phone: 020 7946 0958').text).toBe('Phone: [PHONE_1]');
    expect(masked('tel. 067 123 45 67').text).toBe('tel. [PHONE_1]');
  });

  it('previews only the last digits', () => {
    expect(masked('+1 415 555 0132').items[0]?.preview).toBe('…0132');
  });

  it('leaves dates, times, order numbers, prices and offsets alone', () => {
    untouched('Released 2024-03-15 at 10:30:00 UTC+05:30, order #100234987, invoice INV-2024-0042.');
    untouched('Order 555-123-4567 shipped. Total $1,234.56 (+30 days).');
    untouched('Build 20240315.1 took 1.5 s; results 12/03/2024.');
    untouched('100 200 3000 and 123-456-7890');
  });
});

describe('mask: payment cards', () => {
  it.each([
    ['Visa', '4242 4242 4242 4242', '…4242'],
    ['Visa, no spaces', '4111111111111111', '…1111'],
    ['Mastercard, dashes', '5555-5555-5555-4444', '…4444'],
    ['Amex', '3782 822463 10005', '…0005'],
  ])('%s', (_name, card, preview) => {
    const result = masked(`card=${card} exp=12/28`);
    expect(result.text).toBe('card=[CARD_1] exp=12/28');
    expect(result.items).toEqual([{ category: 'card', placeholder: '[CARD_1]', preview, count: 1 }]);
  });

  it('treats the same number with and without spaces as one card', () => {
    const result = masked('4242 4242 4242 4242 and 4242424242424242');
    expect(result.text).toBe('[CARD_1] and [CARD_1]');
  });

  it('leaves numbers that fail Luhn or look like IDs alone', () => {
    untouched('Order 4242 4242 4242 4241 was cancelled.');
    untouched('Tracking 1234567890123456, timestamp 1727512345678, id 9999999999999999');
    untouched('UUID 12345678-1234-1234-1234-123456789012 and 550e8400-e29b-41d4-a716-446655440000');
    untouched('Sum 4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1');
  });

  it('checks Luhn', () => {
    expect(passesLuhn('4242424242424242')).toBe(true);
    expect(passesLuhn('4242424242424241')).toBe(false);
    expect(passesLuhn('')).toBe(false);
  });
});

describe('mask: IBANs', () => {
  it.each([
    ['DE89 3704 0044 0532 0130 00', 'DE…3000'],
    ['GB82WEST12345698765432', 'GB…5432'],
    ['UA21 3223 1300 0002 6007 2335 6600 1', 'UA…6001'],
    ['NO9386011117947', 'NO…7947'],
  ])('%s', (iban, preview) => {
    const result = masked(`IBAN: ${iban}, thanks`);
    expect(result.text).toBe('IBAN: [IBAN_1], thanks');
    expect(result.items).toEqual([{ category: 'iban', placeholder: '[IBAN_1]', preview, count: 1 }]);
  });

  it('stops at the IBAN length even when an uppercase word follows', () => {
    expect(masked('DE89 3704 0044 0532 0130 00 TEST').text).toBe('[IBAN_1] TEST');
  });

  it('leaves wrong checksums and look-alikes alone', () => {
    untouched('DE89 3704 0044 0532 0130 01');
    untouched('Model XY12 ABCD EFGH 1234 is sold out.');
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('DE8937040044053201300')).toBe(false);
  });
});

describe('mask: IP addresses', () => {
  it('masks IPv4 and keeps the port', () => {
    const result = masked('connect ECONNREFUSED 203.0.113.42:5432 via 10.0.12.7');
    expect(result.text).toBe('connect ECONNREFUSED [IP_1]:5432 via [IP_2]');
    expect(result.items.map((item) => item.preview)).toEqual(['203.…', '10.…']);
  });

  it('masks IPv6', () => {
    expect(masked('from 2001:db8:85a3::8a2e:370:7334 and [fe80::1ff:fe23:4567:890a]:443').text).toBe(
      'from [IP_1] and [[IP_2]]:443',
    );
    expect(masked('2001:0db8:85a3:0000:0000:8a2e:0370:7334').text).toBe('[IP_1]');
  });

  it('leaves versions, loopback, netmasks, times, MACs and C++ scopes alone', () => {
    untouched('Version 1.0.0.1, v2.3.4.5, build 10.0.1.2, Chrome 141.0.7390.54, OID 1.3.6.1.4.1');
    untouched('listening on 127.0.0.1:8080 and 0.0.0.0, netmask 255.255.255.0, ::1');
    untouched('at 12:30:45, MAC 00:1A:2B:3C:4D:5E, std::vector<int>, a::b');
  });
});

describe('mask: home folder paths', () => {
  it.each([
    ['/Users/anna/projects/shop/src/index.ts:42', '<HOME>/projects/shop/src/index.ts:42'],
    ['/home/anna/.ssh/id_ed25519', '<HOME>/.ssh/id_ed25519'],
    ['C:\\Users\\anna\\AppData\\Local\\Temp\\x.log', '<HOME>\\AppData\\Local\\Temp\\x.log'],
    ['"C:\\\\Users\\\\anna\\\\repo"', '"<HOME>\\\\repo"'],
    ['file:///Users/anna/notes.md', 'file://<HOME>/notes.md'],
  ])('%s', (path, output) => {
    const result = masked(path);
    expect(result.text).toBe(output);
    expect(result.items[0]).toMatchObject({ category: 'homePath', placeholder: '<HOME>' });
  });

  it('counts every home path as one item', () => {
    const result = masked('/home/anna/a.txt and /home/anna/b.txt and /Users/bob/c.txt');
    expect(result.text).toBe('<HOME>/a.txt and <HOME>/b.txt and <HOME>/c.txt');
    expect(result.items).toEqual([{ category: 'homePath', placeholder: '<HOME>', preview: '/home/a…', count: 3 }]);
  });

  it('leaves web paths and placeholders alone', () => {
    untouched('https://example.com/home/about and GET /home/feed HTTP/1.1');
    untouched('/Users/Shared/data, /home/$USER/app, /home/<name>/app');
  });
});

describe('mask: combined, stable and configurable', () => {
  const LOG = `2026-09-27 14:03:12 ERROR PaymentService - charge failed for anna.kowalski@example.com
  card=4242 4242 4242 4242 amount=129.00 EUR ip=203.0.113.42
  POST https://api.example.com/v1/charges?api_key=${STRIPE}
  retry for anna.kowalski@example.com in 30s
    at com.example.payments.StripeClient.charge(StripeClient.java:88)
    at /home/anna/shop/server.js:120`;

  it('masks every category in a realistic log and keeps the rest intact', () => {
    const result = masked(LOG);
    expect(result.text).toBe(`2026-09-27 14:03:12 ERROR PaymentService - charge failed for [EMAIL_1]
  card=[CARD_1] amount=129.00 EUR ip=[IP_1]
  POST https://api.example.com/v1/charges?api_key=[API_KEY_1]
  retry for [EMAIL_1] in 30s
    at com.example.payments.StripeClient.charge(StripeClient.java:88)
    at <HOME>/shop/server.js:120`);
    expect(result.items.map((item) => `${item.category}:${item.placeholder}:${item.count}`)).toEqual([
      'apiKey:[API_KEY_1]:1',
      'email:[EMAIL_1]:2',
      'card:[CARD_1]:1',
      'ip:[IP_1]:1',
      'homePath:<HOME>:1',
    ]);
    expect(maskSummary(result.items)).toBe('5 items masked');
  });

  it('never exposes an original value in the output or the previews', () => {
    const result = masked(LOG);
    const originals = ['anna.kowalski@example.com', '4242 4242 4242 4242', '203.0.113.42', STRIPE, '/home/anna'];
    for (const value of originals) {
      expect(result.text).not.toContain(value);
      for (const item of result.items) expect(item.preview).not.toContain(value);
    }
  });

  it('turns categories off individually', () => {
    const result = masked(LOG, ['email', 'homePath']);
    expect(result.text).toContain('anna.kowalski@example.com');
    expect(result.text).toContain('/home/anna/shop');
    expect(result.text).toContain('[CARD_1]');
    expect(masked(LOG, [...MASK_CATEGORIES]).text).toBe(LOG);
  });

  it('shares one mapping across several texts', () => {
    const masker = new Masker();
    expect(masker.mask('Ticket from anna@example.com')).toBe('Ticket from [EMAIL_1]');
    expect(masker.mask('Reply to anna@example.com and bob@example.com')).toBe('Reply to [EMAIL_1] and [EMAIL_2]');
    expect(masker.items.map((item) => item.count)).toEqual([2, 1]);
  });

  it('does not re-mask placeholders or change text without secrets', () => {
    const once = masked(LOG).text;
    expect(masked(once).text).toBe(once);
    untouched('The central bank raised its key rate to 5.25% on March 3, 2024. Governor Anna Kowalski said so.');
    untouched('commit 9fceb02d0ae598e95dc970b74767f19372d61af8, hash a1b2c3d, color #ff00aa, 0xdeadbeef');
  });

  it('handles a large selection quickly', () => {
    const text = `${LOG}\n\n`.repeat(400);
    const started = performance.now();
    const result = masked(text);
    expect(performance.now() - started).toBeLessThan(500);
    expect(result.items.find((item) => item.category === 'email')?.count).toBe(800);
  });

  it('lists categories in rule order', () => {
    expect(categories(`${GITHUB} anna@example.com`)).toEqual(['apiKey', 'email']);
  });

  it('summarizes counts', () => {
    expect(maskSummary([])).toBe('0 items masked');
    expect(maskSummary(masked('a@example.com').items)).toBe('1 item masked');
  });
});
