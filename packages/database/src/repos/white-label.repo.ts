import { eq } from 'drizzle-orm';
import type { CostCoreDatabase } from '../client.js';
import { whiteLabelSettings } from '../schema.js';
import type { WhiteLabelConfig } from '@cost-core/types';

export class WhiteLabelRepository {
  constructor(private db: CostCoreDatabase) {}

  async getSettings(): Promise<WhiteLabelConfig> {
    const rows = await this.db.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global'));
    if (!rows.length) {
      // Varsayılan kayıt oluştur
      const defaultSettings = {
        id: 'global',
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
        updatedAt: new Date().toISOString(),
      };
      await this.db.insert(whiteLabelSettings).values(defaultSettings);
      return defaultSettings;
    }

    const r = rows[0];
    return {
      companyName: r.companyName,
      appTitle: r.appTitle,
      logoUrl: r.logoUrl || undefined,
      faviconUrl: r.faviconUrl || undefined,
      backgroundUrl: r.backgroundUrl || undefined,
      primaryColor: r.primaryColor,
      secondaryColor: r.secondaryColor,
      defaultTheme: r.defaultTheme as any,
      baseCurrency: r.baseCurrency,
      dateFormat: r.dateFormat,
      updatedAt: r.updatedAt,
    };
  }

  async updateSettings(updates: Partial<WhiteLabelConfig>): Promise<WhiteLabelConfig> {
    await this.getSettings(); // Varlığını garantiye al

    const now = new Date().toISOString();
    const updateValues: Record<string, any> = { updatedAt: now };

    if (updates.companyName) updateValues.companyName = updates.companyName;
    if (updates.appTitle) updateValues.appTitle = updates.appTitle;
    if (updates.logoUrl !== undefined) updateValues.logoUrl = updates.logoUrl;
    if (updates.faviconUrl !== undefined) updateValues.faviconUrl = updates.faviconUrl;
    if (updates.backgroundUrl !== undefined) updateValues.backgroundUrl = updates.backgroundUrl;
    if (updates.primaryColor) updateValues.primaryColor = updates.primaryColor;
    if (updates.secondaryColor) updateValues.secondaryColor = updates.secondaryColor;
    if (updates.defaultTheme) updateValues.defaultTheme = updates.defaultTheme;
    if (updates.baseCurrency) updateValues.baseCurrency = updates.baseCurrency;
    if (updates.dateFormat) updateValues.dateFormat = updates.dateFormat;

    await this.db
      .update(whiteLabelSettings)
      .set(updateValues)
      .where(eq(whiteLabelSettings.id, 'global'));

    return this.getSettings();
  }
}
