import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultLanguage, LanguageSelect, LocaleProvider, useLocale } from '../src/context/LocaleContext.js';

function Content() {
  const { t, intlLocale } = useLocale();
  return <><LanguageSelect /><p>{t('İşlemler', 'Transactions')}</p><span>{new Intl.NumberFormat(intlLocale).format(1234.5)}</span></>;
}

function render(language: 'en' | 'tr') {
  return renderToStaticMarkup(<LocaleProvider initialLanguage={language}><Content /></LocaleProvider>);
}

describe('interface language', () => {
  it('prefers the stored choice over the browser language and rejects invalid stored values', () => {
    expect(defaultLanguage('tr', 'en-US')).toBe('tr');
    expect(defaultLanguage('en', 'tr-TR')).toBe('en');
    expect(defaultLanguage('bad', 'tr-TR')).toBe('tr');
    expect(defaultLanguage(null, 'de-DE')).toBe('en');
  });

  it('renders translated labels and numbers with the selected locale', () => {
    const english = render('en');
    const turkish = render('tr');
    expect(english).toContain('aria-label="Language"');
    expect(english).toContain('<p>Transactions</p>');
    expect(english).toContain('<span>1,234.5</span>');
    expect(turkish).toContain('aria-label="Dil"');
    expect(turkish).toContain('<p>İşlemler</p>');
    expect(turkish).toContain('<span>1.234,5</span>');
  });
});
