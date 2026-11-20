import { describe, it, expect } from 'vitest';
import {
  UserSchema,
  CategorySchema,
  CustomFieldDefinitionSchema,
  TransactionSchema,
  AuditLogSchema,
  WhiteLabelConfigSchema,
} from '../src/index.js';

describe('@cost-core/types Validation Tests', () => {
  it('should validate a valid User object', () => {
    const validUser = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      username: 'patron',
      email: 'patron@sirket.com',
      fullName: 'Ahmet Yılmaz',
      role: 'admin',
      isActive: true,
      twoFactorEnabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = UserSchema.parse(validUser);
    expect(parsed.username).toBe('patron');
    expect(parsed.role).toBe('admin');
  });

  it('should validate a Hierarchical Category object', () => {
    const validCategory = {
      id: '123e4567-e89b-12d3-a456-426614174001',
      name: 'Kaba Yapı',
      code: 'KY-01',
      parentId: null,
      color: '#3B82F6',
      icon: 'building',
      orderIndex: 1,
      customFieldIds: [],
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = CategorySchema.parse(validCategory);
    expect(parsed.name).toBe('Kaba Yapı');
    expect(parsed.parentId).toBeNull();
  });

  it('should validate a Custom Field Definition', () => {
    const validField = {
      id: '123e4567-e89b-12d3-a456-426614174002',
      name: 'plaka_no',
      label: 'Araç Plakası',
      type: 'text',
      required: true,
      placeholder: '34 ABC 123',
    };
    const parsed = CustomFieldDefinitionSchema.parse(validField);
    expect(parsed.type).toBe('text');
    expect(parsed.required).toBe(true);
  });

  it('should validate a Transaction with customValues', () => {
    const validTx = {
      id: '123e4567-e89b-12d3-a456-426614174003',
      type: 'expense',
      date: new Date().toISOString(),
      amount: 45000,
      currency: 'TRY',
      exchangeRate: 1,
      baseAmount: 45000,
      categoryId: '123e4567-e89b-12d3-a456-426614174001',
      title: 'Hazır Beton Alımı',
      description: '32m3 C35 Hazır Beton',
      party: 'Akçansa Beton',
      customValues: {
        irsaliye_no: 'IRS-2026-99',
        metrekup: 32,
      },
      status: 'approved',
      createdById: '123e4567-e89b-12d3-a456-426614174000',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const parsed = TransactionSchema.parse(validTx);
    expect(parsed.amount).toBe(45000);
    expect(parsed.customValues.metrekup).toBe(32);
  });

  it('should validate Audit Log hash integrity', () => {
    const validAudit = {
      id: '123e4567-e89b-12d3-a456-426614174004',
      userId: '123e4567-e89b-12d3-a456-426614174000',
      action: 'UPDATE',
      entity: 'transaction',
      entityId: '123e4567-e89b-12d3-a456-426614174003',
      timestamp: new Date().toISOString(),
      previousState: { amount: 40000 },
      newState: { amount: 45000 },
      hash: 'a'.repeat(64),
      previousHash: 'b'.repeat(64),
    };
    const parsed = AuditLogSchema.parse(validAudit);
    expect(parsed.action).toBe('UPDATE');
    expect(parsed.hash.length).toBe(64);
  });

  it('should validate WhiteLabel configuration with default values', () => {
    const parsed = WhiteLabelConfigSchema.parse({
      companyName: 'Akdeniz İnşaat & Taahhüt',
    });
    expect(parsed.companyName).toBe('Akdeniz İnşaat & Taahhüt');
    expect(parsed.primaryColor).toBe('#2563EB');
    expect(parsed.defaultTheme).toBe('dark');
  });
});
