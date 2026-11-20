import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Language = 'en' | 'tr';

const STORAGE_KEY = 'tzrcoster_language';

export function defaultLanguage(stored: string | null | undefined, browserLanguage = ''): Language {
  if (stored === 'en' || stored === 'tr') return stored;
  return browserLanguage.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

type Translator = (turkish: string, english: string) => string;

interface LocaleContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  intlLocale: string;
  t: Translator;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const defaultContext: LocaleContextValue = {
  language: 'tr',
  setLanguage: () => {},
  intlLocale: 'tr-TR',
  t: (turkish) => turkish,
};

function readPreference() {
  if (typeof window === 'undefined') return 'tr';
  try {
    return defaultLanguage(window.localStorage.getItem(STORAGE_KEY), window.navigator.language);
  } catch {
    return defaultLanguage(null, window.navigator.language);
  }
}

export function LocaleProvider({ children, initialLanguage }: { children: React.ReactNode; initialLanguage?: Language }) {
  const [language, setLanguage] = useState<Language>(() => initialLanguage ?? readPreference());

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'en' ? 'TZR Cost Tracker' : 'TZR Maliyet Takip';
    try { window.localStorage.setItem(STORAGE_KEY, language); } catch { /* Use the current tab preference. */ }
  }, [language]);

  const value = useMemo<LocaleContextValue>(() => ({
    language,
    setLanguage,
    intlLocale: language === 'en' ? 'en-US' : 'tr-TR',
    t: (turkish, english) => language === 'en' ? english : turkish,
  }), [language]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? defaultContext;
}

export function LanguageSelect() {
  const { language, setLanguage, t } = useLocale();
  const label = t('Dil', 'Language');
  return (
    <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
      <span>{label}</span>
      <select
        aria-label={label}
        value={language}
        onChange={(event) => setLanguage(defaultLanguage(event.target.value))}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-700 shadow-sm focus:border-blue-600 focus:outline-none"
      >
        <option value="en">English</option>
        <option value="tr">Türkçe</option>
      </select>
    </label>
  );
}
