import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@cost-core/types';
import { CompanyDebtTable } from '../src/components/CompanyDebtTable.js';

const row = (id: string, changes: Record<string, unknown> = {}): Transaction => ({ id, projectId: 'synthetic', title: id, date: '2026-11-01', type: 'expense', status: 'approved', isPaid: false, paymentSource: 'company_account', amount: 123, currency: 'TRY', ...changes } as Transaction);
const excluded = [
  ...['draft', 'pending_approval', 'rejected', 'cancelled', undefined, 'unknown'].map((status, i) => row('excluded-status-' + i, { status })),
  row('excluded-deleted', { deletedAt: '2026-11-01' }), row('excluded-income', { type: 'income' }),
  row('excluded-transfer', { type: 'transfer' }), row('excluded-paid', { isPaid: true }),
  row('excluded-person', { paymentSource: 'person_out_of_pocket' }),
  row('excluded-oto-income', { type: 'income', paymentSource: 'person_out_of_pocket' }),
];
const mark = vi.fn();
const render = (transactions: Transaction[], isLoading = false, canMutate?: boolean) => renderToStaticMarkup(React.createElement(CompanyDebtTable, { transactions, isLoading, canMutate, onMarkPaid: mark }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('CompanyDebtTable', () => {
  it('selects company obligations with native currencies and due dates', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    const html = render([row('approved-today', { dueDate: '2026-11-14T23:59:00Z', baseAmount: 99999 }), row('pending-future', { status: 'pending', dueDate: '2026-11-15', currency: 'USD', amount: 45, baseAmount: 99999 }), row('paid-no-due', { status: 'paid', dueDate: null }), ...excluded], false, true);
    for (const id of ['approved-today', 'pending-future', 'paid-no-due']) expect(html).toContain(id);
    for (const tx of excluded) expect(html).not.toContain(tx.title);
    expect(html).toContain('GECİKMİŞ BORÇ'); expect(html).toContain('Vadeli Bekliyor'); expect(html).toContain('Vade Belirtilmemiş');
    expect(html).toContain(new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(123));
    expect(html).toContain(new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'USD' }).format(45));
    expect(html).not.toContain('99.999'); expect((html.match(/Ödendi Yap/g) || []).length).toBe(3); expect(mark).not.toHaveBeenCalled();
  });
  it('shows scoped empty text only after loading', () => {
    expect(render(excluded)).toContain('Gösterilen kayıtlarda bekleyen şirket borcu yok');
    expect(render([], true)).not.toContain('Gösterilen kayıtlarda bekleyen şirket borcu yok'); expect(render([], true)).toContain('yükleniyor');
  });
  it('defaults to no action and hides action without permission', () => {
    expect(render([row('eligible')])).not.toContain('Ödendi Yap'); expect(render([row('eligible')], false, false)).not.toContain('Ödendi Yap');
  });
  it('binds the eligible id only to its click', () => {
    const tree = CompanyDebtTable({ transactions: [row('eligible'), ...excluded], isLoading: false, canMutate: true, onMarkPaid: mark });
    const buttons: React.ReactElement<any>[] = [];
    const visit = (node: React.ReactNode): void => { React.Children.forEach(node, child => { if (!React.isValidElement<any>(child)) return; if (child.type === 'button') buttons.push(child); visit(child.props.children); }); };
    visit(tree); expect(mark).not.toHaveBeenCalled(); expect(buttons).toHaveLength(1); buttons[0].props.onClick(); expect(mark).toHaveBeenCalledTimes(1); expect(mark).toHaveBeenCalledWith('eligible');
  });
});
