import { formatCurrency } from '../format-currency.js';
import React from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { Wallet, AlertTriangle, Clock, TrendingUp, TrendingDown, Users } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.js';

interface CurrencyBalance { actualCashInHand: number; totalPendingExpense: number; netPositionAfterDue: number; overdueDebt?: number; crossScopeWalletNetTotal?: number; inactiveWalletBalanceTotal?: number; inactiveAccountCount?: number; }

interface BalanceBarProps {
  balance: {
    baseCurrency?: string; mixedCurrency?: boolean; excludedCurrencies?: string[]; cashScopeMode?: 'current' | 'filtered_period'; byCurrency?: Record<string, CurrencyBalance>; crossScopeWalletNetTotal?: number; inactiveWalletBalanceTotal?: number; inactiveAccountCount?: number;
    totalIncome: number;
    totalPaidExpense: number;
    actualCashInHand: number;
    totalPendingExpense: number;
    overdueDebt: number;
    netPositionAfterDue: number;
    totalTransactions: number;
    personContributions: Array<{
      personName: string;
      directKasaAmount: number;
      otoKasaAmount: number;
      totalAmount: number;
      transactionCount: number;
    }>;
  } | null;
  onOpenPersonContributions: () => void;
}

export const BalanceBar: React.FC<BalanceBarProps> = ({ balance, onOpenPersonContributions }) => {
  const { settings } = useTheme();
  const { t, intlLocale } = useLocale();
  const localize = t;
  const currency = balance?.baseCurrency || settings.baseCurrency || 'TRY';
  const period = balance?.cashScopeMode === 'filtered_period';

  const formatMoney = (val: number, moneyCurrency = currency) => {
    return formatCurrency(intlLocale, moneyCurrency, val || 0, 2);
  };

  const actualCash = balance?.actualCashInHand || 0;
  const overdueDebt = balance?.overdueDebt || 0;
  const pendingDebt = balance?.totalPendingExpense || 0;
  const netPosition = balance?.netPositionAfterDue || 0;

  const transparency = (item: Pick<CurrencyBalance, 'crossScopeWalletNetTotal' | 'inactiveWalletBalanceTotal' | 'inactiveAccountCount'>, code: string) => (
    <div className='text-xs text-slate-600 space-y-1'>
      {!!item.crossScopeWalletNetTotal && <p>{localize("Seçili cüzdan kapsamı dışındaki net hareket (", "Net movement outside selected accounts (")}{code}): {item.crossScopeWalletNetTotal > 0 ? '+' : ''}{formatMoney(item.crossScopeWalletNetTotal, code)} (ana tutara eklenmez)</p>}
      {!!item.inactiveWalletBalanceTotal && <p>{localize("Pasif cüzdan bakiyesi (", "Inactive account balance (")}{code}): {formatMoney(item.inactiveWalletBalanceTotal, code)}{localize(" (ana nakit toplamına dahil değildir)", " (excluded from the cash total)")}</p>}
      {!!item.inactiveAccountCount && <p>{localize("Pasif hesap sayısı (", "Inactive accounts (")}{code}): {item.inactiveAccountCount}</p>}
    </div>
  );
  if (!balance) return <div className='mb-6 text-slate-500' role='status'>{t('Bakiye raporu henüz yok.', 'No balance report yet.')}</div>;

  return (
    <div className="mb-6 space-y-3">
      {/* 4'lü Canlı Bilanço Barı */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3.5">
        {/* 1. Eldeki Gerçek Nakit */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 mb-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>{period ? 'DÖNEM NAKİT AKIŞI' : 'GÜNCEL NAKİT DURUMU'}</span>
            </div>
            <h3 className={`text-xl font-bold font-mono ${actualCash >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
              {formatMoney(actualCash)}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {period ? 'Seçili dönemdeki net nakit hareketleri' : 'Yetkili cüzdan bakiyeleri (açılış dahil) ve atanmamış nakit/kart net hareketleri'}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600">
            <Wallet className="h-5 w-5" />
          </div>
        </div>

        {/* 2. Vadesi Gelmiş / Geçmiş Borç (Kırmızı Alarm) */}
        <div
          className={`border rounded-xl p-4 shadow-sm flex items-center justify-between transition-all ${
            overdueDebt > 0
              ? 'bg-rose-50 border-rose-300'
              : 'bg-white border-slate-200'
          }`}
        >
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-700 mb-1">
              {overdueDebt > 0 && <AlertTriangle className="h-3.5 w-3.5 text-rose-600 animate-bounce" />}
              <span>{period ? 'SEÇİLİ DÖNEM KAYITLARINDA VADESİ GELMİŞ / GEÇMİŞ BORÇ' : 'VADESİ GELMİŞ / GEÇMİŞ BORÇ'}</span>
            </div>
            <h3 className="text-xl font-bold font-mono text-rose-700">
              {formatMoney(overdueDebt)}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {period ? (overdueDebt > 0 ? 'Seçili dönem kayıtlarında vadesi gelmiş / geçmiş borç' : 'Seçili dönem kayıtlarında vadesi geçmiş borç yok') : (overdueDebt > 0 ? '🚨 Derhal ödenmesi gereken borç' : '🟢 Vadesi geçmiş borç yok')}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-rose-100 border border-rose-200 flex items-center justify-center text-rose-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
        </div>

        {/* 3. Toplam Bekleyen / Vadeli Borç */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 mb-1">
              <Clock className="h-3.5 w-3.5" />
              <span>{period ? 'SEÇİLİ DÖNEM KAYITLARINDA BEKLEYEN BORÇ' : 'TOPLAM BEKLEYEN / VADELİ'}</span>
            </div>
            <h3 className="text-xl font-bold font-mono text-amber-700">
              {formatMoney(pendingDebt)}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {period ? 'Seçili dönem kayıtlarındaki ödenmemiş giderler' : 'İleri tarihli çek, senet & hakedişler'}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600">
            <Clock className="h-5 w-5" />
          </div>
        </div>

        {/* 4. Vade Sonrası Net Durum */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-700 mb-1">
              {netPosition >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
              <span>{period ? 'DÖNEM BORÇLARI SONRASI NET AKIŞ' : 'VADE SONRASI NET DURUM'}</span>
            </div>
            <h3
              className={`text-xl font-bold font-mono ${
                netPosition >= 0 ? 'text-blue-700' : 'text-rose-600'
              }`}
            >
              {formatMoney(netPosition)}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {period ? 'Seçili dönem net nakit akışından seçili dönem kayıtlarının ödenmemiş giderleri düşülür' : (netPosition >= 0 ? '🟢 Tüm vadeler sonrası artı bakiye' : '🔴 Fon açığı / Ek kaynak gerekli')}
            </p>
          </div>
          <div className="h-10 w-10 rounded-xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600">
            {netPosition >= 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
          </div>
        </div>
      </div>

      {(balance.mixedCurrency || !!balance.excludedCurrencies?.length) && <div role='status' className='rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900'>{localize("Ana toplamlar yalnızca ", "Main totals are in ")}{currency}{localize(" içerir; diğer para birimleri ayrı gösterilir.", " only. Other currencies are shown separately.")}{balance.excludedCurrencies?.length ? ' Hariç tutulanlar: ' + balance.excludedCurrencies.join(', ') : null}</div>}
      {transparency(balance, currency)}
      {Object.entries(balance.byCurrency ?? {}).filter(([code]) => code !== currency).map(([code, item]) => (
        <section key={code} aria-label={code + ' ayrı bakiye'} className='rounded-xl border border-slate-200 bg-white p-4 text-sm space-y-1'>
          <h3 className='font-semibold'>{code}{localize(" — ayrı bakiye", " — separate balance")}</h3>
          <p>{period ? 'Dönem nakit akışı' : 'Güncel nakit durumu'}: {formatMoney(item.actualCashInHand, code)}</p>
          <p>{period ? 'Seçili dönem kayıtlarında bekleyen borç' : 'Toplam bekleyen / vadeli'}: {formatMoney(item.totalPendingExpense, code)}</p>
          <p>{period ? 'Dönem borçları sonrası net akış' : 'Vade sonrası net durum'}: {formatMoney(item.netPositionAfterDue, code)}</p>
          {item.overdueDebt != null && <p>{period ? 'Seçili dönem kayıtlarında vadesi gelmiş / geçmiş borç' : 'Vadesi gelmiş / geçmiş borç'}: {formatMoney(item.overdueDebt, code)}</p>}
          {transparency(item, code)}
        </section>
      ))}
      {/* Şahıs Kasa & Oto-Kasa Katkı Özeti Butonu */}
      {balance?.personContributions && balance.personContributions.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-xs shadow-sm">
          <div className="flex items-center gap-2 text-slate-700">
            <Users className="h-4 w-4 text-blue-600" />
            <span>
              <strong>{localize("Ortak / Şahıs Finansmanı:", "Partner and personal funds:")}</strong> {balance.personContributions.length}{localize(" kişi tarafından toplam", " contributors provided")}{' '}
              <span className="font-bold text-emerald-700 font-mono">
                {formatMoney(balance.personContributions.reduce((s, p) => s + p.totalAmount, 0))}
              </span>{' '}
              {localize("fon sağlandı. (En yüksek: ", "in total. (Largest contribution: ")}{balance.personContributions[0].personName} -{' '}
              {formatMoney(balance.personContributions[0].totalAmount)})
            </span>
          </div>
          <button
            onClick={onOpenPersonContributions}
            className="text-blue-600 hover:text-blue-800 font-semibold underline flex items-center gap-1"
          >
            {localize("Kişi Dökümünü Gör ›", "View contributions ›")}
          </button>
        </div>
      )}
    </div>
  );
};
