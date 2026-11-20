import { describe, expect, it } from 'vitest';
import { mapImportHeaders, validateImportColumnMapping } from '../src/components/UniversalExcelModal.js';

describe('UniversalExcelModal import mapping', () => {
  it('remaps required columns for a newly selected sheet and rejects stale indices', () => {
    const first = mapImportHeaders(['Date', 'Title', 'Amount', 'Paid']);
    expect(first).toMatchObject({ dateCol: 0, titleCol: 1, amountCol: 2, isPaidCol: 3 });

    const second = mapImportHeaders(['Title', 'Amount', 'Date']);
    expect(second).toMatchObject({ dateCol: 2, titleCol: 0, amountCol: 1, isPaidCol: -1 });
    expect(validateImportColumnMapping(second, 3)).toBeNull();
    expect(validateImportColumnMapping({ ...second, amountCol: 4 }, 3)).toBe('amountCol');
    expect(validateImportColumnMapping(mapImportHeaders(['Title', 'Amount']), 2)).toBe('dateCol');
    expect(validateImportColumnMapping({ ...second, dateCol: 1.5 }, 3)).toBe('dateCol');
  });
});
