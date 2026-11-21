import { describe, it, expect } from 'vitest';
import { TransactionSchema, CreateTransactionSchema, CreateProjectSchema, AuditLogSchema } from '../src/index.js';
const tx={id:'123e4567-e89b-12d3-a456-426614174003',date:new Date().toISOString(),amount:100,baseAmount:100,categoryId:'123e4567-e89b-12d3-a456-426614174001',title:'Synthetic',createdById:'123e4567-e89b-12d3-a456-426614174000',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
describe('security schema regression',()=>{
it('accepts arbitrary customValues fields',()=>{const p=TransactionSchema.parse({...tx,customValues:{plate:'34AA01',qty:3,flag:true,nested:{a:1},nothing:null}});expect(p.customValues.plate).toBe('34AA01');expect(p.customValues.qty).toBe(3);});
it('rejects invalid customValues collections',()=>{expect(TransactionSchema.safeParse({...tx,customValues:'nope'}).success).toBe(false);expect(TransactionSchema.safeParse({...tx,customValues:[1,2]}).success).toBe(false);expect(CreateTransactionSchema.safeParse({date:tx.date,amount:1,categoryId:tx.categoryId,title:'x',customValues:42}).success).toBe(false);});
it('retains default customValues',()=>{expect(TransactionSchema.parse(tx).customValues).toEqual({});});
it('retains nullable and omitted audit state',()=>{const base={id:'123e4567-e89b-12d3-a456-426614174004',action:'UPDATE',entity:'transaction',timestamp:new Date().toISOString(),hash:'a'.repeat(64)};const p=AuditLogSchema.parse({...base,previousState:null,newState:{amount:5}});expect(p.previousState).toBeNull();expect(p.newState).toEqual({amount:5});const q=AuditLogSchema.parse(base);expect(q.previousState).toBeUndefined();expect(q.newState).toBeUndefined();});
});

it.each(['12!', 'USDx', ' US', ''])('rejects invalid currency %j on ledger inputs', currency => {
  const input = { type: 'expense', date: tx.date, amount: 1, categoryId: tx.categoryId, title: 'Synthetic', currency };
  expect(CreateTransactionSchema.safeParse(input).success).toBe(false);
  expect(CreateProjectSchema.safeParse({ name: 'Test project', currency }).success).toBe(false);
});

it('normalizes lowercase currency on input without relabeling the value', () => {
  expect(CreateProjectSchema.parse({ name: 'Test project', currency: 'eur' }).currency).toBe('EUR');
});