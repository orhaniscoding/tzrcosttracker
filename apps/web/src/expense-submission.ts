import { ApiClient } from './api/client.js';

type ExpenseBody = Record<string, unknown>;
type SendExpense<T> = (data: ExpenseBody, key: string) => Promise<T>;

type Attempt<T> = { key: string; promise?: Promise<T> };

// The form sends a flat record of strings, dates serialized as strings, numbers,
// and booleans. Sorting only its top-level fields keeps retries stable without
// losing fields if a nested value is added later.
function expenseJson(data: ExpenseBody): string {
  return JSON.stringify(Object.fromEntries(Object.keys(data).sort().map(key => [key, data[key]])));
}

export function createExpenseSubmission<T = unknown>(
  send: SendExpense<T>,
  makeKey: () => string = () => crypto.randomUUID(),
) {
  const attempts = new Map<string, Attempt<T>>();

  function submit(scope: string, data: ExpenseBody): Promise<T> {
    const body = expenseJson(data);
    const signature = JSON.stringify([scope, body]);
    const previous = attempts.get(signature);
    if (previous?.promise) return previous.promise;
    const attempt = previous ?? { key: makeKey() };
    // Capture authentication in the current event before awaiting a response.
    let response: Promise<T>;
    try { response = send(JSON.parse(body), attempt.key); }
    catch (error) { response = Promise.reject(error); }
    const promise = response.then(result => {
      if (attempts.get(signature) === attempt) attempts.delete(signature);
      return result;
    }, error => {
      // Leave this key attached to the same draft. A failed request or lost
      // response does not tell the client whether the server committed it.
      attempt.promise = undefined;
      throw error;
    });
    attempt.promise = promise;
    attempts.set(signature, attempt);
    return promise;
  }

  return Object.assign(submit, { clear: () => attempts.clear() });
}

export const sendExpense = (data: ExpenseBody, key: string) => ApiClient.createTransaction(data, key);
