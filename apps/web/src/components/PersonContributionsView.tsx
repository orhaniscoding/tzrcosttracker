import React, { useEffect, useMemo, useState } from 'react';
import { useLocale } from '../context/LocaleContext.js';
import type { Transaction } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';

interface PersonContribution {
  personName: string;
  directKasaAmount: number;
  otoKasaAmount: number;
  totalAmount: number;
  transactionCount: number;
}

interface ContributionReport {
  baseCurrency?: string;
  personContributions: PersonContribution[];
  byCurrency?: Record<string, { personContributions: PersonContribution[] }>;
  cashScopeMode?: 'current' | 'filtered_period';
}

interface PersonContributionsViewProps {
  transactions: Transaction[];
  report: ContributionReport | null;
  isLoading?: boolean;
}

const personName = (tx: Transaction) => tx.payerPersonName || tx.party || 'Diğer';
const isOto = (tx: Transaction) => Boolean(tx.otoKasaTransactionId) || tx.paymentSource === 'person_out_of_pocket';
const isContribution = (tx: Transaction) =>
  !tx.deletedAt && tx.type === 'income' &&
  (tx.status === 'approved' || tx.status === 'pending' || tx.status === 'paid') &&
  tx.isPaid !== false && (isOto(tx) || tx.status !== 'pending');

const formatMoney = (amount: number, currency: string, locale = 'tr-TR') =>
  `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(amount)} ${currency}`;

export const PersonContributionsView: React.FC<PersonContributionsViewProps> = ({ transactions, report, isLoading = false }) => {
  const { settings } = useTheme();
  const { t, intlLocale } = useLocale();
  const localize = t;
  const [selectedPerson, setSelectedPerson] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const loaded = useMemo(() => transactions.filter(isContribution), [transactions]);
  const baseCurrency = report?.baseCurrency || settings.baseCurrency || 'TRY';
  const panels = useMemo(() => {
    if (!report) return [];
    return [
      { currency: baseCurrency, people: report.personContributions },
      ...Object.entries(report.byCurrency || {})
        .filter(([currency]) => currency !== baseCurrency)
        .map(([currency, value]) => ({ currency, people: value.personContributions })),
    ];
  }, [report, baseCurrency]);

  useEffect(() => {
    if (isLoading || !report || !selectedPerson) return;
    const inReport = panels.some(panel => panel.people.some(person => person.personName === selectedPerson));
    const inLoaded = loaded.some(tx => personName(tx) === selectedPerson);
    if (!inReport && !inLoaded) setSelectedPerson(null);
  }, [isLoading, report, selectedPerson, panels, loaded]);

  if (isLoading) return <div role="status">{localize("Şahıs katkı raporu yükleniyor.", "Loading the contribution report.")}</div>;
  if (!report) return <div role="status">{localize("Şahıs katkı raporu kullanılamıyor.", "The contribution report is unavailable.")}</div>;

  const query = searchTerm.toLocaleLowerCase('tr-TR');
  const details = loaded.filter(tx => {
    const name = personName(tx);
    return (!selectedPerson || name === selectedPerson) &&
      (!query || name.toLocaleLowerCase('tr-TR').includes(query) || tx.title.toLocaleLowerCase('tr-TR').includes(query));
  });
  return (
    <div className="space-y-6 min-w-0">
      <div>
        <h2 className="text-lg font-bold">{report.cashScopeMode === 'filtered_period' ? t('Seçili dönem katkıları', 'Contributions in the selected period') : t('Sunucu raporu kapsamındaki katkılar', 'Contributions in the server report')}</h2>
        <p>{t('Kartlar sunucu raporu kapsamındadır; kişi seçimi ve arama yalnız yüklenen katkı detaylarını süzer.', 'Cards reflect the server report; person selection and search filter only the loaded contribution details.')}</p>
      </div>
      {panels.map(({ currency, people }) => {
        const total = people.reduce((sum, person) => sum + person.totalAmount, 0);
        const direct = people.reduce((sum, person) => sum + person.directKasaAmount, 0);
        const oto = people.reduce((sum, person) => sum + person.otoKasaAmount, 0);
        return (
          <section key={currency} aria-label={`${t('Şahıs katkıları', 'Personal contributions')} ${currency}`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <h3 className="font-bold">{t('Şahıs katkıları', 'Personal contributions')} {currency}</h3>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="min-w-0 break-words"><dt>{t('Toplam katkı', 'Total contribution')}</dt><dd className="font-bold">{formatMoney(total, currency, intlLocale)}</dd></div>
              <div className="min-w-0 break-words"><dt>{t('Doğrudan katkı', 'Direct contribution')}</dt><dd className="font-bold">{formatMoney(direct, currency, intlLocale)}</dd></div>
              <div className="min-w-0 break-words"><dt>{t('OTO katkısı', 'Out-of-pocket contribution')}</dt><dd className="font-bold">{formatMoney(oto, currency, intlLocale)}</dd></div>
            </dl>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {people.map(person => (
                <button key={person.personName} type="button" aria-pressed={selectedPerson === person.personName} onClick={() => setSelectedPerson(current => current === person.personName ? null : person.personName)} className={"min-w-0 rounded-lg border p-3 text-left break-words hover:bg-slate-50 " + (selectedPerson === person.personName ? "border-blue-600 bg-blue-50 ring-2 ring-blue-500" : "border-slate-200")}>
                  <h4 className="font-bold break-all">{person.personName}</h4>
                  <div>{t('Toplam katkı:', 'Total contribution:')} {formatMoney(person.totalAmount, currency, intlLocale)}</div>
                  <div>{t('Doğrudan katkı:', 'Direct contribution:')} {formatMoney(person.directKasaAmount, currency, intlLocale)}</div>
                  <div>{t('OTO katkısı:', 'Out-of-pocket contribution:')} {formatMoney(person.otoKasaAmount, currency, intlLocale)}</div>
                  <div>{t('Katkı kaydı:', 'Contribution records:')} {person.transactionCount}</div>
                  <div>{(total === 0 ? 0 : person.totalAmount / total * 100).toFixed(1)}%</div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <section className="min-w-0 space-y-3" aria-label={t('Yüklenen katkı kayıtları', 'Loaded contribution records')}>
        <h3 className="font-bold">{t('Yüklenen katkı kayıtları', 'Loaded contribution records')}</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <label>{t('Kişi veya başlık ara', 'Search person or title')}<input className="block border rounded p-2" type="search" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} /></label>
          <button type="button" className="border rounded p-2" onClick={() => { setSelectedPerson(null); setSearchTerm(''); }}>{t('Filtreleri sıfırla', 'Reset filters')}</button>
        </div>
        <div role="region" aria-label={localize("Yüklenen katkı kayıtları tablosu", "Contribution records table")} tabIndex={0} className="overflow-x-auto max-w-full">
          <table className="min-w-[700px] w-full text-left">
            <thead><tr><th>{localize("Tarih", "Date")}</th><th>{localize("Kişi", "Person")}</th><th>{localize("Başlık ve bağlam", "Title and context")}</th><th>Durum</th><th>{localize("Ödeme", "Payment")}</th><th>{localize("Katkı tutarı", "Contribution")}</th></tr></thead>
            <tbody>
              {details.length === 0 && <tr><td colSpan={6}>{localize("Yüklenen kayıtlar arasında bu ölçütlere uygun katkı bulunmuyor.", "No contributions match the filters.")}</td></tr>}
              {details.map(tx => {
                const oto = isOto(tx);
                const linked = oto && tx.otoKasaTransactionId ? transactions.find(candidate => candidate.id === tx.otoKasaTransactionId && candidate.type === 'expense') : undefined;
                return (
                  <tr key={tx.id} data-testid={`contribution-${tx.id}`}>
                    <td>{tx.date.split('T')[0]}</td>
                    <td>{personName(tx)}</td>
                    <td><div>{tx.title}</div><div>{oto ? 'Şahıs finansmanı — OTO yansıması' : 'Doğrudan katkı'}</div>
                      {oto && (linked ? <div>{localize("İlişkili gider: ", "Related expense: ")}{linked.title} — Durum: {linked.status}{localize(" — Ödeme: ", " — Payment: ")}{linked.isPaid === false ? 'Ödenmemiş' : linked.isPaid === true ? 'Ödenmiş' : 'Belirtilmemiş'} — {linked.deletedAt ? 'Silinmiş' : 'Silinmemiş'}</div> : <div>{localize("İlişkili gider yüklenen kayıtlarda bulunmuyor", "The related expense is outside the loaded records")}</div>)}
                    </td>
                    <td>{tx.status}</td><td>{tx.isPaid === false ? 'Ödenmemiş' : tx.isPaid === true ? 'Ödenmiş' : 'Belirtilmemiş'}</td>
                    <td>{formatMoney(tx.amount, tx.currency || baseCurrency, intlLocale)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};
