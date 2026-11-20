import { describe, expect, it } from 'vitest';
import type { Category, Transaction } from '@cost-core/types';
import { buildReportCSV } from '../src/report-csv';

const tx = (overrides: Record<string, unknown> = {}): Transaction => ({ date: '2026-01-02T12:00:00Z', type: 'income', title: 'Title', amount: 10, currency: 'TRY', categoryId: 'cat', isPaid: true, status: 'approved', paymentSource: 'company_account', ...overrides } as unknown as Transaction);
const category = (id: string, name: string): Category => ({ id, name } as Category);
const header = '\uFEFF\x22Tarih\x22;\x22T\u00fcr\x22;\x22Ba\u015fl\u0131k\x22;\x22Tutar\x22;\x22D\u00f6viz\x22;\x22Kategori\x22;\x22Tedarik\u00e7i/Cari\x22;\x22\u00d6deme Kayna\u011f\u0131\x22;\x22\u00d6deyen Ki\u015fi\x22;\x22\u0130\u015flem Durumu\x22;\x22\u00d6deme Durumu\x22;\x22A\u00e7\u0131klama\x22';

describe('buildReportCSV', () => {
  it('preserves frozen raw rows, native amounts and source order', () => {
    const records = [tx({ title: 'draft', status: 'draft', amount: -2.5, baseAmount: 999 }), tx({ title: 'deleted', deletedAt: '2026-01-03', amount: 0, isPaid: false }), tx({ title: 'OTO', otoKasaTransactionId: 'linked', amount: 1.25 }), tx({ title: 'transfer', type: 'transfer', currency: 'USD', amount: 3 })];
    const categories = [category('cat', 'Food')];
    records.forEach(Object.freeze); categories.forEach(Object.freeze); Object.freeze(records); Object.freeze(categories);
    const before = JSON.stringify([records, categories]);
    expect(buildReportCSV(records, categories)).toBe([header,
      '\x222026-01-02\x22;\x22income\x22;\x22draft\x22;-2.5;\x22TRY\x22;\x22Food\x22;\x22\x22;\x22company_account\x22;\x22\x22;\x22draft\x22;\x22\u00d6dendi\x22;\x22\x22',
      '\x222026-01-02\x22;\x22income\x22;\x22deleted\x22;0;\x22TRY\x22;\x22Food\x22;\x22\x22;\x22company_account\x22;\x22\x22;\x22approved\x22;\x22\u00d6denmedi\x22;\x22\x22',
      '\x222026-01-02\x22;\x22income\x22;\x22OTO\x22;1.25;\x22TRY\x22;\x22Food\x22;\x22\x22;\x22company_account\x22;\x22\x22;\x22approved\x22;\x22\u00d6dendi\x22;\x22\x22',
      '\x222026-01-02\x22;\x22transfer\x22;\x22transfer\x22;3;\x22USD\x22;\x22Food\x22;\x22\x22;\x22company_account\x22;\x22\x22;\x22approved\x22;\x22\u00d6dendi\x22;\x22\x22',
    ].join('\r\n'));
    expect(JSON.stringify([records, categories])).toBe(before);
    expect(buildReportCSV([], [])).toBe(header);
  });
  it('protects every variable text column and preserves escaped content', () => {
    const record = tx({ date: '=dateT12', type: '+type', title: '-title', currency: '@currency', party: '\tparty', paymentSource: '\rsource', payerPersonName: '\npayer', status: '\0status', description: 'a;\x22b\x22\r\n\u0130stanbul #% \u{1F600}', isPaid: false });
    expect(buildReportCSV([record], [category('cat', '\u200b \x27\uFF1Dcategory')])).toBe([header,
      '\x22Metin: =date\x22;\x22Metin: +type\x22;\x22Metin: -title\x22;10;\x22Metin: @currency\x22;\x22Metin: \u200b \x27\uFF1Dcategory\x22;\x22Metin: \tparty\x22;\x22Metin: \rsource\x22;\x22Metin: \npayer\x22;\x22Metin: \0status\x22;\x22\u00d6denmedi\x22;\x22a;\x22\x22b\x22\x22\r\n\u0130stanbul #% \u{1F600}\x22',
    ].join('\r\n'));
  });
  it('protects fullwidth operators and ignores safe leading and midstring characters', () => {
    const titles = ['\uFF1Dfoo', '\uFF0Bfoo', '\uFF0Dfoo', '\uFF20foo', ' \u0001\u200d\x27\x27=foo', ' x+y', '\x27ordinary', 'middle=@-+'];
    const expected = ['\x22Metin: \uFF1Dfoo\x22', '\x22Metin: \uFF0Bfoo\x22', '\x22Metin: \uFF0Dfoo\x22', '\x22Metin: \uFF20foo\x22', '\x22Metin:  \u0001\u200d\x27\x27=foo\x22', '\x22 x+y\x22', '\x22\x27ordinary\x22', '\x22middle=@-+\x22'];
    const rows = expected.map(cell => '\x222026-01-02\x22;\x22income\x22;' + cell + ';10;\x22TRY\x22;\x22\x22;\x22\x22;\x22\x22;\x22\x22;\x22\x22;\x22\u00d6dendi\x22;\x22\x22');
    expect(buildReportCSV(titles.map(title => tx({ title, paymentSource: undefined, status: undefined })), [])).toBe([header, ...rows].join('\r\n'));
  });
  it('neutralizes a formula in the description field', () => {
    const csv = buildReportCSV([tx({ description: '=1+1' })], []);
    const fields = csv.split('\r\n')[1].split(';');
    expect(fields).toHaveLength(12);
    expect(fields[11]).toBe('\x22Metin: =1+1\x22');
  });
  it('rejects non-finite and non-number amounts even after a valid row', () => {
    for (const amount of [NaN, Infinity, -Infinity, '12']) {
      expect(() => buildReportCSV([tx(), tx({ amount })], [])).toThrow(/amount.*finite number/i);
    }
  });
});