import type { Category, Transaction } from '@cost-core/types';

const headers = ['Tarih', 'T\u00fcr', 'Ba\u015fl\u0131k', 'Tutar', 'D\u00f6viz', 'Kategori', 'Tedarik\u00e7i/Cari', '\u00d6deme Kayna\u011f\u0131', '\u00d6deyen Ki\u015fi', '\u0130\u015flem Durumu', '\u00d6deme Durumu', 'A\u00e7\u0131klama'];

function textCell(value: string): string {
  const stripped = value.normalize('NFKC').replace(/^(?:[\p{White_Space}\p{Cc}\p{Cf}]|\u0027)+/u, '');
  const dangerous = /^[\t\r\n\u0000]/.test(value) || (stripped.length > 0 && new Set(['=', '+', '-', '@', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']).has(stripped.charAt(0)));
  const safe = dangerous ? 'Metin: ' + value : value;
  return '\x22' + safe.replace(/\x22/g, '\x22\x22') + '\x22';
}

export function buildReportCSV(transactions: readonly Transaction[], categories: readonly Category[]): string {
  for (const transaction of transactions) {
    if (typeof transaction.amount !== 'number' || !Number.isFinite(transaction.amount)) {
      throw new Error('Transaction amount must be a finite number');
    }
  }
  const categoryMap = new Map(categories.map(category => [category.id, category]));
  const rows = transactions.map(transaction => [
    textCell(transaction.date.split('T')[0]),
    textCell(transaction.type),
    textCell(transaction.title),
    String(transaction.amount),
    textCell(transaction.currency),
    textCell(categoryMap.get(transaction.categoryId)?.name ?? ''),
    textCell(transaction.party ?? ''),
    textCell(transaction.paymentSource ?? ''),
    textCell(transaction.payerPersonName ?? ''),
    textCell(transaction.status ?? ''),
    textCell(transaction.isPaid ? '\u00d6dendi' : '\u00d6denmedi'),
    textCell(transaction.description ?? ''),
  ].join(';'));
  return '\uFEFF' + [headers.map(textCell).join(';'), ...rows].join('\r\n');
}