import { describe, expect, it } from 'vitest';
import type { Category, Transaction } from '@cost-core/types';
import { computeReportFinance } from '../src/report-finance';
const load = import('../src/category-finance').catch(() => ({ computeCategoryExpense: undefined }));
const cat = (id: string, parentId?: string) => ({ id, parentId } as Category);
const tx = (categoryId: string, amount: number, extra: Record<string, unknown> = {}) => ({ type: 'expense', categoryId, amount, baseAmount: 999999, currency: 'TRY', status: 'approved', isPaid: true, paymentSource: 'company_account', ...extra } as Transaction);
describe('category finance', () => {
  it('exports the helper', async () => { expect((await load).computeCategoryExpense).toBeTypeOf('function'); });
  it('attributes expenses once and delegates finance', async () => {
    const compute = (await load).computeCategoryExpense; expect(compute).toBeTypeOf('function'); if (!compute) return;
    const cats = [cat('R'), cat('C', 'R'), cat('G', 'C'), cat('R2')];
    const records = [tx('R',10), tx('C',20,{status:'pending',isPaid:false,paymentSource:'person_out_of_pocket'}), tx('G',30,{status:'paid',paymentSource:'person_out_of_pocket'}), tx('C',40,{subcategoryId:'G',isPaid:false}), tx('G',5,{currency:'USD'}), tx('G',7,{subcategoryId:'R2'}), tx('G',900,{status:'draft'}), tx('G',900,{status:'rejected'}), tx('G',900,{deletedAt:'2026-01-01'}), tx('G',900,{type:'income'}), tx('G',900,{type:'income',otoKasaTransactionId:'oto'}), tx('G',900,{type:'income',paymentSource:'person_out_of_pocket'}), tx('G',900,{type:'transfer'})];
    cats.forEach(Object.freeze); records.forEach(Object.freeze); Object.freeze(cats); Object.freeze(records); const before = JSON.stringify([cats,records]);
    for (const [id,ids,total] of [['R',['R','C','G'],107],['C',['C','G'],97],['G',['G'],77],['R2',['R2'],7]] as const) {
      const result = compute(id,cats,records,'TRY'); expect(result.categoryIds).toEqual(new Set(ids)); expect(result.hasHierarchyIssue).toBe(false);
      const set = new Set<string>(ids); const selected = records.filter(t => t.type === 'expense' && (set.has(t.categoryId) || (t.subcategoryId != null && set.has(t.subcategoryId))));
      expect(result.finance).toEqual(computeReportFinance(selected,'TRY')); expect(result.finance.totalExpense).toBe(total); if (id !== 'R2') expect(result.finance.byCurrency.USD.totalExpense).toBe(5);
    }
    const root = compute('R',cats,records.slice(0,5),'TRY').finance; expect(root).toMatchObject({totalExpense:100,transactionCount:4,totalPaidExpense:40,companyPaidExpenseTotal:10,personFundedExpenseTotal:30,totalPendingExpense:40});
    const usd = compute('R',cats,records.slice(0,5),'USD').finance; expect(usd.totalExpense).toBe(5); expect(usd.byCurrency.TRY.totalExpense).toBe(100); expect(JSON.stringify([cats,records])).toBe(before);
  });
  it('detects connected hierarchy defects', async () => {
    const compute = (await load).computeCategoryExpense; expect(compute).toBeTypeOf('function'); if (!compute) return;
    const cats = [cat('A','B'),cat('B','A'),cat('S','S'),cat('O','missing'),cat('child','O'),cat('N')]; const records = [tx('A',2),tx('B',3),tx('S',4),tx('O',11)];
    for (const [id,ids,total,issue] of [['A',['A','B'],5,true],['B',['A','B'],5,true],['S',['S'],4,true],['O',['O','child'],11,true],['child',['child'],0,true],['N',['N'],0,false],['unknown',['unknown'],0,true]] as const) { const result = compute(id,cats,records,'TRY'); expect(result.categoryIds).toEqual(new Set(ids)); expect(result.hasHierarchyIssue).toBe(issue); expect(result.finance.totalExpense).toBe(total); }
  });
  it('handles deep frozen trees, empty inputs and rounding', async () => {
    const compute = (await load).computeCategoryExpense; expect(compute).toBeTypeOf('function'); if (!compute) return;
    const cats = Array.from({length:2000},(_,i) => Object.freeze(cat(String(i),i ? String(i-1) : undefined))); const records = [tx('1999',1.005),tx('1999',0.335),tx('1999',0.1)]; records.forEach(Object.freeze); Object.freeze(cats); Object.freeze(records);
    const result = compute('0',cats,records,'TRY'); expect(result.categoryIds.size).toBe(2000); expect(result.hasHierarchyIssue).toBe(false); expect(result.finance).toEqual(computeReportFinance(records,'TRY')); expect(result.finance.totalExpense).toBe(1.45);
    const empty = compute('missing',[],[],'TRY'); expect(empty.categoryIds).toEqual(new Set(['missing'])); expect(empty.hasHierarchyIssue).toBe(true); expect(empty.finance).toEqual(computeReportFinance([],'TRY'));
  });
});
