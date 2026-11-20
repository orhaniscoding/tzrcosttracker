import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { AuditLogRepository, whiteLabelSettings, type CostCoreDatabase } from '@cost-core/database';
import { WhiteLabelConfigSchema } from '@cost-core/types';
import { ForbiddenError, SessionInvalidError } from '../services/project-access.service.js';

class SettingsValidationError extends Error {}

// Partial update: omitted keys stay undefined so they never reset stored values.
const updateSchema = WhiteLabelConfigSchema.omit({ updatedAt: true }).partial();
const declaredKeys = new Set(Object.keys(updateSchema.shape));

// Public branding projection: id/updatedAt stay server-only and are never selected.
const publicColumns = {
  companyName: whiteLabelSettings.companyName,
  appTitle: whiteLabelSettings.appTitle,
  logoUrl: whiteLabelSettings.logoUrl,
  faviconUrl: whiteLabelSettings.faviconUrl,
  backgroundUrl: whiteLabelSettings.backgroundUrl,
  primaryColor: whiteLabelSettings.primaryColor,
  secondaryColor: whiteLabelSettings.secondaryColor,
  defaultTheme: whiteLabelSettings.defaultTheme,
  baseCurrency: whiteLabelSettings.baseCurrency,
  dateFormat: whiteLabelSettings.dateFormat,
};
const fullColumns = { ...publicColumns, updatedAt: whiteLabelSettings.updatedAt };

// Same values as WhiteLabelRepository.getSettings() creates, kept in memory only.
const DEFAULT_SETTINGS = {
  companyName: 'TZRCoster Finance',
  appTitle: 'TZRCoster Maliyet & Finans',
  logoUrl: null,
  faviconUrl: null,
  backgroundUrl: null,
  primaryColor: '#2563EB',
  secondaryColor: '#1E40AF',
  defaultTheme: 'dark' as const,
  baseCurrency: 'TRY',
  dateFormat: 'DD.MM.YYYY',
};

type PublicRow = {
  companyName: string;
  appTitle: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  backgroundUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  defaultTheme: string | null;
  baseCurrency: string;
  dateFormat: string;
};

// Same null/empty-to-undefined DTO semantics as WhiteLabelRepository.getSettings.
function publicDto(row: PublicRow) {
  return {
    companyName: row.companyName,
    appTitle: row.appTitle,
    logoUrl: row.logoUrl || undefined,
    faviconUrl: row.faviconUrl || undefined,
    backgroundUrl: row.backgroundUrl || undefined,
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    defaultTheme: row.defaultTheme,
    baseCurrency: row.baseCurrency,
    dateFormat: row.dateFormat,
  };
}
function fullDto(row: PublicRow & { updatedAt: string }) {
  return { ...publicDto(row), updatedAt: row.updatedAt };
}

function settingsError(reply: FastifyReply, error: unknown) {
  if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
  if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
  if (error instanceof SettingsValidationError) return reply.status(400).send({ error: 'Geçersiz veri.' });
  return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
}

export const settingsRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess } = fastify;
  const db = fastify.db as CostCoreDatabase;

  // BEYAZ ETİKET AYARLARI OKU (giriş öncesi marka görünürlüğü).
  // WhiteLabelRepository remains async; the public read is a synchronous read
  // transaction with an explicit projection and never seeds/audits a default.
  fastify.get('/white-label', async (_request, reply) => {
    try {
      const row = db.transaction(tx =>
        tx.select(publicColumns).from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).get());
      return reply.send(publicDto(row ?? DEFAULT_SETTINGS));
    } catch (error) { return settingsError(reply, error); }
  });

  // BEYAZ ETİKET GÜNCELLE — fresh admin/session before validation in one
  // immediate synchronous transaction, with the audit bound to the same tx.
  fastify.put('/white-label', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const updated = db.transaction(tx => {
        const userId = (request.user as { id: string }).id, session = request.authSession;
        projectAccess.requireFreshAdmin(tx, userId, session?.id as string, session ? Number(session.expiresAt) : NaN);

        const parse = updateSchema.safeParse(request.body);
        if (!parse.success) throw new SettingsValidationError();
        const input = parse.data;
        // Only keys actually sent may change; schema defaults for omitted keys
        // must never reset an existing field.
        const body = (request.body ?? {}) as Record<string, unknown>;
        const provided = new Set(Object.keys(body).filter(key => declaredKeys.has(key)));

        const previous = tx.select(fullColumns).from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).get();
        const now = new Date().toISOString();
        if (!previous) {
          // Missing global row: seed repository defaults, then update. Both the
          // insert and the update roll back with the transaction on any failure.
          tx.insert(whiteLabelSettings).values({ id: 'global', ...DEFAULT_SETTINGS, updatedAt: now }).run();
        }

        const values: Partial<typeof whiteLabelSettings.$inferInsert> = { updatedAt: now };
        // Repository semantics: text fields apply on truthy input, URL fields on
        // provided input (null clears), and an empty dateFormat stays a no-op.
        if (provided.has('companyName') && input.companyName) values.companyName = input.companyName;
        if (provided.has('appTitle') && input.appTitle) values.appTitle = input.appTitle;
        if (provided.has('logoUrl') && input.logoUrl !== undefined) values.logoUrl = input.logoUrl;
        if (provided.has('faviconUrl') && input.faviconUrl !== undefined) values.faviconUrl = input.faviconUrl;
        if (provided.has('backgroundUrl') && input.backgroundUrl !== undefined) values.backgroundUrl = input.backgroundUrl;
        if (provided.has('primaryColor') && input.primaryColor) values.primaryColor = input.primaryColor;
        if (provided.has('secondaryColor') && input.secondaryColor) values.secondaryColor = input.secondaryColor;
        if (provided.has('defaultTheme') && input.defaultTheme) values.defaultTheme = input.defaultTheme;
        if (provided.has('baseCurrency') && input.baseCurrency) values.baseCurrency = input.baseCurrency;
        if (provided.has('dateFormat') && input.dateFormat) values.dateFormat = input.dateFormat;
        tx.update(whiteLabelSettings).set(values).where(eq(whiteLabelSettings.id, 'global')).run();

        const result = fullDto(tx.select(fullColumns).from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).get()!);
        // Repository accepts the root DB type but uses only the shared
        // synchronous transaction API. Bind it to this tx, never fastify.db.
        new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({
          userId, action: 'SETTINGS_UPDATE', entity: 'white_label', entityId: 'global',
          ipAddress: request.ip, userAgent: request.headers['user-agent'],
          previousState: previous ? fullDto(previous) : null, newState: result,
        }, config.masterKey);
        return result;
      }, { behavior: 'immediate' });
      return reply.send(updated);
    } catch (error) { return settingsError(reply, error); }
  });
};
