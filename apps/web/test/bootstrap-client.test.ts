import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from '../src/api/client.js';

const SETUP_SECRET = 'synthetic-setup-secret-0123456789abcdef';
const SESSION_TOKEN = 'synthetic-session-jwt-token';

function okResponse(body: any) {
  return { ok: true, status: 200, json: async () => body };
}

describe('bootstrap setup client', () => {
  beforeEach(() => { ApiClient.setToken(null); });
  afterEach(() => { ApiClient.setToken(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('sends exact x-setup-token header only, body and URL contain no secret', async () => {
    const fetchMock = vi.fn(async () => okResponse({ token: SESSION_TOKEN, user: { id: 'u1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const data = { companyName: 'Sentetik Sirket', baseCurrency: 'TRY', admin: { username: 'admin', fullName: 'Sentetik Admin', email: 'a@example.invalid', password: 'synthetic-password', pin: '1234' }, industryTemplate: 'construction' };
    await ApiClient.setupSystem(data, SETUP_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as any[];
    const url = call[0] as string; const init = call[1] as any;
    expect(url).toBe('/api/system/setup');
    expect(url).not.toContain(SETUP_SECRET);
    expect(init.headers['x-setup-token']).toBe(SETUP_SECRET);
    expect(JSON.parse(init.body)).toEqual(data);
    expect(init.body).not.toContain(SETUP_SECRET);
    expect(JSON.parse(init.body)).not.toHaveProperty('setupToken');
    expect(JSON.parse(init.body)).not.toHaveProperty('bootstrapToken');
    expect(ApiClient.getToken()).toBeNull();
  });

  it('does not leak setup header into a subsequent normal request', async () => {
    const fetchMock = vi.fn(async () => okResponse({ token: SESSION_TOKEN, user: { id: 'u1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await ApiClient.setupSystem({ companyName: 'Sentetik' }, SETUP_SECRET);
    await ApiClient.getMe();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = fetchMock.mock.calls[1] as any[];
    expect((second[1] as any).headers).not.toHaveProperty('x-setup-token');
    expect(JSON.stringify(second)).not.toContain(SETUP_SECRET);
  });

  it('keeps normal JWT session handling unchanged and never treats bootstrap key as session token', async () => {
    const fetchMock = vi.fn(async () => okResponse({ id: 'u1' }));
    vi.stubGlobal('fetch', fetchMock);
    ApiClient.setToken(SESSION_TOKEN);
    expect(ApiClient.getToken()).toBe(SESSION_TOKEN);
    expect(ApiClient.getToken()).not.toBe(SETUP_SECRET);
    await ApiClient.getMe();
    const call = fetchMock.mock.calls[0] as any[];
    expect((call[1] as any).headers['Authorization']).toBe('Bearer ' + SESSION_TOKEN);
    expect((call[1] as any).headers).not.toHaveProperty('x-setup-token');
  });
});
