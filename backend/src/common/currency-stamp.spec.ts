import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * ARCHITECTURE TEST — every money row must be created with a currency on it.
 *
 * WHY THIS TEST EXISTS RATHER THAN A MIDDLEWARE
 * The right way to make a rule unforgettable is to remove the chance to
 * forget: one choke point that stamps every row. That is not available here.
 * Prisma REMOVED `$use` middleware in v6, and its replacement `$extends`
 * returns a *new* client instead of mutating the injected one — so wiring it
 * into a NestJS `PrismaService` needs either a constructor-return trick or a
 * proxy over every model accessor. Both are framework magic that fails
 * silently on an upgrade, in the money path, where failing silently means
 * financial records with no currency on them that no later migration can
 * repair, because the information was never captured in the first place.
 *
 * So the stamp is explicit at each call site, and THIS test is what makes it
 * unforgettable instead. It reads the source, finds every place an Invoice or
 * Payment is created, and fails if any of them is missing a currency stamp.
 * Someone adding the fourteenth call site gets a red build naming their file,
 * rather than a silent gap discovered during an audit.
 *
 * WHY IT MATTERS AT ALL
 * `Isp.currency` is an editable settings field, and amounts used to be stored
 * bare and rendered with whatever it currently said. Change it and the entire
 * financial history is reinterpreted: a 5,000 PKR invoice from last year reads
 * as 5,000 USD, in every report, with no error anywhere. It is the same shape
 * as the gateway bug fixed earlier — a number crossing into a context that
 * reinterprets it — and the cure is the same: capture the currency at write
 * time and never infer it later.
 */
const SRC = join(__dirname, '..');

/** Creates that are not money rows in the accounting sense. */
const EXEMPT: Array<{ file: string; reason: string }> = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walk(p, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

type Site = { file: string; line: number; model: string; snippet: string };

/**
 * Find `<something>.invoice.create({` / `.payment.create({` and capture the
 * `data` block that follows, so we can check what it sets.
 *
 * Matching the source text is crude, and deliberately so: a cleverer check
 * (reflection, a runtime hook) would only prove something about the paths the
 * test happened to exercise. This proves a property of the whole codebase.
 */
function findCreateSites(): Site[] {
  const sites: Site[] = [];
  const re = /\.(invoice|payment)\.create(Many)?\s*\(\s*\{/g;

  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // Take a generous window after the match — enough to contain the data
      // block of even the longest create in the codebase.
      const snippet = src.slice(m.index, m.index + 1400);
      sites.push({
        file: file.replace(SRC + '/', ''),
        line: src.slice(0, m.index).split('\n').length,
        model: m[1],
        snippet,
      });
    }
  }
  return sites;
}

describe('currency stamping — architecture', () => {
  const sites = findCreateSites();

  it('finds the money-creating call sites at all (guards against the regex rotting)', () => {
    // If a refactor changes how creates are written, this test would silently
    // start passing by finding nothing. That failure mode is worse than the
    // one it is guarding against, so assert the search still works.
    expect(sites.length).toBeGreaterThanOrEqual(10);
    expect(sites.some((s) => s.model === 'invoice')).toBe(true);
    expect(sites.some((s) => s.model === 'payment')).toBe(true);
  });

  it('stamps a currency at EVERY invoice and payment create site', () => {
    const missing = sites
      .filter((s) => !EXEMPT.some((e) => s.file === e.file))
      .filter((s) => {
        // Either spread a stamp helper, or set `currency:` explicitly — both
        // are honest; what is forbidden is neither.
        const stamped =
          /\.\.\.\(await [^)]*\.(invoiceStamp|paymentStamp)\(/.test(s.snippet) ||
          /(^|[^A-Za-z])currency\s*:/.test(s.snippet);
        return !stamped;
      })
      .map((s) => `${s.file}:${s.line} (${s.model}.create)`);

    expect(missing).toEqual([]);
  });

  it('records a base amount and rate wherever a payment is created', () => {
    // A payment that may have arrived in another currency is only summable if
    // its equivalent in the invoice's currency was recorded at the time. The
    // stamp helper supplies baseAmount and fxRate together; an explicit
    // `currency:` without them would produce a row reports cannot total.
    const bad = sites
      .filter((s) => s.model === 'payment')
      .filter((s) => {
        const viaHelper = /\.\.\.\(await [^)]*\.paymentStamp\(/.test(s.snippet);
        const manual = /baseAmount\s*:/.test(s.snippet);
        return !viaHelper && !manual;
      })
      .map((s) => `${s.file}:${s.line}`);

    expect(bad).toEqual([]);
  });
});

describe('ledger postings', () => {
  it('stamps a currency on every posted line', () => {
    // AccountingService.post() is the single choke point for ledger writes, so
    // unlike invoices and payments there is exactly one place to check — but
    // it is worth pinning, because an unlabelled ledger makes a trial balance
    // that sums across currencies, which is not a wrong number so much as a
    // meaningless one.
    const src = readFileSync(join(SRC, 'accounting/accounting.service.ts'), 'utf8');
    const post = src.slice(src.indexOf('async post('), src.indexOf('async post(') + 1800);

    expect(post).toMatch(/billingCurrencyOrBlank\(\)/);
    expect(post).toMatch(/ledgerEntry\.createMany/);
    // The currency must be inside the mapped row, not merely computed nearby.
    const rows = post.slice(post.indexOf('data: lines.map'));
    expect(rows).toMatch(/(^|[^A-Za-z])currency,/);
  });

  it('resolves the currency once per posting, not once per line', () => {
    // A single balanced posting is one transaction in one currency. Resolving
    // per line could straddle a currency change made mid-posting and produce
    // lines that no longer balance against each other.
    const src = readFileSync(join(SRC, 'accounting/accounting.service.ts'), 'utf8');
    const post = src.slice(src.indexOf('async post('), src.indexOf('async post(') + 1800);
    const resolveIdx = post.indexOf('billingCurrencyOrBlank()');
    const mapIdx = post.indexOf('lines.map');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(mapIdx);
  });
});
