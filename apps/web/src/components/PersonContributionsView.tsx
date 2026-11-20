import React, { useEffect, useMemo, useState } from 'react';
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

const formatMoney = (amount: number, currency: string) =>
  `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(amount)} ${currency}`;

export const PersonContributionsView: React.FC<PersonContributionsViewProps> = ({ transactions, report, isLoading = false }) => {
  const { settings } = useTheme();
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

  if (isLoading) return <div role="status">Şahıs katkı raporu yükleniyor.</div>;
  if (!report) return <div role="status">Şahıs katkı raporu kullanılamıyor.</div>;

  const query = searchTerm.toLocaleLowerCase('tr-TR');
  const details = loaded.filter(tx => {
    const name = personName(tx);
    return (!selectedPerson || name === selectedPerson) &&
      (!query || name.toLocaleLowerCase('tr-TR').includes(query) || tx.title.toLocaleLowerCase('tr-TR').includes(query));
  });
  return (
    <div className="space-y-6 min-w-0">
      <div>
        <h2 className="text-lg font-bold">{report.cashScopeMode === 'filtered_period' ? 'Seçili dönem katkıları' : 'Sunucu raporu kapsamındaki katkılar'}</h2>
        <p>Kartlar sunucu raporu kapsamındadır; kişi seçimi ve arama yalnız yüklenen katkı detaylarını süzer.</p>
      </div>
      {panels.map(({ currency, people }) => {
        const total = people.reduce((sum, person) => sum + person.totalAmount, 0);
        const direct = people.reduce((sum, person) => sum + person.directKasaAmount, 0);
        const oto = people.reduce((sum, person) => sum + person.otoKasaAmount, 0);
        return (
          <section key={currency} aria-label={`Şahıs katkıları ${currency}`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <h3 className="font-bold">Şahıs katkıları {currency}</h3>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="min-w-0 break-words"><dt>Toplam katkı</dt><dd className="font-bold">{formatMoney(total, currency)}</dd></div>
              <div className="min-w-0 break-words"><dt>Doğrudan katkı</dt><dd className="font-bold">{formatMoney(direct, currency)}</dd></div>
              <div className="min-w-0 break-words"><dt>OTO katkısı</dt><dd className="font-bold">{formatMoney(oto, currency)}</dd></div>
            </dl>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {people.map(person => (
                <button key={person.personName} type="button" aria-pressed={selectedPerson === person.personName} onClick={() => setSelectedPerson(current => current === person.personName ? null : person.personName)} className={"min-w-0 rounded-lg border p-3 text-left break-words hover:bg-slate-50 " + (selectedPerson === person.personName ? "border-blue-600 bg-blue-50 ring-2 ring-blue-500" : "border-slate-200")}>
                  <h4 className="font-bold break-all">{person.personName}</h4>
                  <div>Toplam katkı: {formatMoney(person.totalAmount, currency)}</div>
                  <div>Doğrudan katkı: {formatMoney(person.directKasaAmount, currency)}</div>
                  <div>OTO katkısı: {formatMoney(person.otoKasaAmount, currency)}</div>
                  <div>Katkı kaydı: {person.transactionCount}</div>
                  <div>{(total === 0 ? 0 : person.totalAmount / total * 100).toFixed(1)}%</div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      <section className="min-w-0 space-y-3" aria-label="Yüklenen katkı kayıtları">
        <h3 className="font-bold">Yüklenen katkı kayıtları</h3>
        <div className="flex flex-wrap gap-3 items-end">
          <label>Kişi veya başlık ara<input className="block border rounded p-2" type="search" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} /></label>
          <button type="button" className="border rounded p-2" onClick={() => { setSelectedPerson(null); setSearchTerm(''); }}>Filtreleri sıfırla</button>
        </div>
        <div role="region" aria-label="Yüklenen katkı kayıtları tablosu" tabIndex={0} className="overflow-x-auto max-w-full">
          <table className="min-w-[700px] w-full text-left">
            <thead><tr><th>Tarih</th><th>Kişi</th><th>Başlık ve bağlam</th><th>Durum</th><th>Ödeme</th><th>Katkı tutarı</th></tr></thead>
            <tbody>
              {details.length === 0 && <tr><td colSpan={6}>Yüklenen kayıtlar arasında bu ölçütlere uygun katkı bulunmuyor.</td></tr>}
              {details.map(tx => {
                const oto = isOto(tx);
                const linked = oto && tx.otoKasaTransactionId ? transactions.find(candidate => candidate.id === tx.otoKasaTransactionId && candidate.type === 'expense') : undefined;
                return (
                  <tr key={tx.id} data-testid={`contribution-${tx.id}`}>
                    <td>{tx.date.split('T')[0]}</td>
                    <td>{personName(tx)}</td>
                    <td><div>{tx.title}</div><div>{oto ? 'Şahıs finansmanı — OTO yansıması' : 'Doğrudan katkı'}</div>
                      {oto && (linked ? <div>İlişkili gider: {linked.title} — Durum: {linked.status} — Ödeme: {linked.isPaid === false ? 'Ödenmemiş' : linked.isPaid === true ? 'Ödenmiş' : 'Belirtilmemiş'} — {linked.deletedAt ? 'Silinmiş' : 'Silinmemiş'}</div> : <div>İlişkili gider yüklenen kayıtlarda bulunmuyor</div>)}
                    </td>
                    <td>{tx.status}</td><td>{tx.isPaid === false ? 'Ödenmemiş' : tx.isPaid === true ? 'Ödenmiş' : 'Belirtilmemiş'}</td>
                    <td>{formatMoney(tx.amount, tx.currency || baseCurrency)}</td>
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
