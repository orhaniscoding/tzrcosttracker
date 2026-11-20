import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { createExpenseSubmission } from '../src/expense-submission.js';

const expense = { title: 'Synthetic expense', amount: 42.5 };
const firstKey = '501ccdaa-b67a-419f-9b70-7da76a47215d';
const nextKey = 'a483ba02-86f5-4f31-9a09-7443c68a5edd';
afterEach(() => vi.unstubAllGlobals());

describe('expense submission', () => {
  it('reuses the same body and key after an uncertain response and rotates the key after success', async () => {
    const writes = new Map<string, string>();
    const fetcher = vi.fn(async (_url: string, request: RequestInit) => {
      const key = new Headers(request.headers).get('Idempotency-Key');
      if (!key) throw new Error('Missing idempotency key');
      const body = String(request.body);
      const previous = writes.get(key);
      if (previous !== undefined && previous !== body) throw new Error('Changed retry body');
      if (previous === undefined) writes.set(key, body);
      if (fetcher.mock.calls.length === 1) throw new TypeError('Response lost after commit');
      return new Response(JSON.stringify({ transaction: { id: key } }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetcher);
    const makeKey = vi.fn().mockReturnValueOnce(firstKey).mockReturnValueOnce(nextKey);
    const submit = createExpenseSubmission(ApiClient.createTransaction, makeKey);
    await expect(submit('session:project', expense)).rejects.toThrow('Response lost');
    await expect(submit('session:project', { amount: 42.5, title: 'Synthetic expense' })).resolves.toMatchObject({ transaction: { id: firstKey } });
    expect(writes.size).toBe(1);
    await expect(submit('session:project', expense)).resolves.toMatchObject({ transaction: { id: nextKey } });
    expect(writes.size).toBe(2);
  });

  it('shares in-flight submission and separates account scopes and changed drafts', async () => {
    let finish!: () => void;
    const first = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const makeKey = vi.fn().mockReturnValueOnce(firstKey).mockReturnValueOnce(nextKey).mockReturnValue('another');
    const submit = createExpenseSubmission(send, makeKey);
    const pending = submit('session-a:project', expense);
    expect(submit('session-a:project', expense)).toBe(pending);
    await submit('session-a:project', { ...expense, amount: 50 });
    await submit('session-b:project', expense);
    finish();
    await pending;
    expect(send.mock.calls.map(call => call[1])).toEqual([firstKey, nextKey, 'another']);
  });
});
