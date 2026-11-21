import React, { useState } from 'react';
import { X, Palette, Check } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.js';
import { useLocale } from '../context/LocaleContext.js';

interface WhiteLabelModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WhiteLabelModal: React.FC<WhiteLabelModalProps> = ({ isOpen, onClose }) => {
  const { t } = useLocale();
  const { settings, updateSettings } = useTheme();

  const [companyName, setCompanyName] = useState(settings.companyName || '');
  const [appTitle, setAppTitle] = useState(settings.appTitle || '');
  const [logoUrl, setLogoUrl] = useState(settings.logoUrl || '');
  const [backgroundUrl, setBackgroundUrl] = useState(settings.backgroundUrl || '');
  const [primaryColor, setPrimaryColor] = useState(settings.primaryColor || '#2563EB');
  const [secondaryColor, setSecondaryColor] = useState(settings.secondaryColor || '#1E40AF');
  const [baseCurrency, setBaseCurrency] = useState(settings.baseCurrency || 'TRY');
  const [defaultTheme, setDefaultTheme] = useState<'light' | 'dark' | 'system'>(settings.defaultTheme || 'dark');
  const [isSaving, setIsSaving] = useState(false);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSaving(true);
      await updateSettings({
        companyName,
        appTitle,
        logoUrl: logoUrl || undefined,
        backgroundUrl: backgroundUrl || undefined,
        primaryColor,
        secondaryColor,
        baseCurrency,
        defaultTheme,
      });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <Palette className="h-5 w-5 text-purple-400" />
            {t('Firma Kimliği & Kozmetik Ayarlar (White-Label)', 'Company Branding & Appearance')}
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-4 overflow-y-auto text-xs">
          <div>
            <label className="block text-slate-300 font-medium mb-1">{t('Şirket / Firma Ünvanı *', 'Company Name *')}</label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              placeholder={t('Örn: Akdeniz İnşaat & Mimarlık A.Ş.', 'E.g. Northwind Construction Ltd.')}
              required
            />
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">{t('Program Başlığı', 'App Title')}</label>
            <input
              type="text"
              value={appTitle}
              onChange={(e) => setAppTitle(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              placeholder={t('Örn: Şantiye Maliyet Takip Portali', 'E.g. Site Cost Tracker')}
            />
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">{t('Firma Logo URL', 'Company Logo URL')}</label>
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              placeholder={t('https://sirketiniz.com/logo.png', 'https://example.com/logo.png')}
            />
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">{t('Özel Arka Plan Görseli (Wallpaper URL)', 'Custom Background Image URL')}</label>
            <input
              type="url"
              value={backgroundUrl}
              onChange={(e) => setBackgroundUrl(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              placeholder={t('Örn: Şantiye veya ofis fotoğrafı URL\'si', 'E.g. URL of a site or office photo')}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 font-medium mb-1">{t('Ana Renk (Primary Color)', 'Primary Color')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="w-10 h-8 rounded bg-transparent cursor-pointer"
                />
                <input
                  type="text"
                  value={primaryColor}
                  onChange={(e) => setPrimaryColor(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">{t('İkincil Renk (Secondary)', 'Secondary Color')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={secondaryColor}
                  onChange={(e) => setSecondaryColor(e.target.value)}
                  className="w-10 h-8 rounded bg-transparent cursor-pointer"
                />
                <input
                  type="text"
                  value={secondaryColor}
                  onChange={(e) => setSecondaryColor(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-slate-200 font-mono"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-slate-300 font-medium mb-1">{t('Varsayılan Para Birimi', 'Default Currency')}</label>
              <select
                value={baseCurrency}
                onChange={(e) => setBaseCurrency(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              >
                <option value="TRY">{t('TRY (Türk Lirası)', 'TRY (Turkish Lira)')}</option>
                <option value="USD">{t('USD (Amerikan Doları)', 'USD (US Dollar)')}</option>
                <option value="EUR">{t('EUR (Euro)', 'EUR (Euro)')}</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">{t('Tema Modu', 'Theme')}</label>
              <select
                value={defaultTheme}
                onChange={(e) => setDefaultTheme(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              >
                <option value="dark">{t('Koyu Mod (Dark)', 'Dark Mode')}</option>
                <option value="light">{t('Açık Mod (Light)', 'Light Mode')}</option>
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition"
            >
              {t('Vazgeç', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium flex items-center gap-1.5 transition disabled:opacity-50"
              style={{ backgroundColor: primaryColor }}
            >
              <Check className="h-4 w-4" />
              <span>{t('Kaydet ve Uygula', 'Save and Apply')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
