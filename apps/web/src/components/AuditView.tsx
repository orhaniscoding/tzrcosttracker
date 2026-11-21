import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, RefreshCw, KeyRound, CheckCircle2 } from 'lucide-react';
import { ApiClient } from '../api/client.js';
import { useLocale } from '../context/LocaleContext.js';

interface AuditViewProps {
  auditVerified: boolean | null;
  onRefreshAudit: () => Promise<void>;
}

export const AuditView: React.FC<AuditViewProps> = ({ auditVerified, onRefreshAudit }) => {
  const { t } = useLocale();
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<any>(null);

  const handleVerifyNow = async () => {
    try {
      setIsVerifying(true);
      const res = await ApiClient.verifyAudit();
      setVerifyResult(res);
      await onRefreshAudit();
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Güvenlik Mührü Kartı */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              className={`h-14 w-14 rounded-2xl flex items-center justify-center shrink-0 border ${
                auditVerified === true
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-600'
                  : 'bg-rose-50 border-rose-300 text-rose-600'
              }`}
            >
              {auditVerified === true ? <ShieldCheck className="h-8 w-8" /> : <ShieldAlert className="h-8 w-8" />}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-slate-900">
                  {auditVerified === true
                    ? t('Kriptografik SHA-256 Denetim Zinciri Doğrulandı', 'Cryptographic SHA-256 Audit Chain Verified')
                    : t('UYARI: Denetim Zincirinde Uyuşmazlık', 'WARNING: Audit Chain Mismatch')}
                </h3>
                <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                  Zero-Knowledge
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1 max-w-2xl">
                {t('Sistemdeki her mali hareket, kategori ve kasa işlemi, önceki satırın hash değeriyle kriptografik olarak birbirine bağlanır. Veritabanı sunucusuna yetkisiz girilip tek bir kuruş veya açıklama harici değiştirilse bile zincir bozulur ve sistem anında alarm verir.', 'The system cryptographically links each financial transaction, category, and cash entry to the previous row’s hash. An unauthorized database change as small as one cent or a description edit breaks the chain and triggers an alert.')}
              </p>
            </div>
          </div>

          <button
            onClick={handleVerifyNow}
            disabled={isVerifying}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isVerifying ? 'animate-spin' : ''}`} />
            <span>{isVerifying ? t('Zincir Taranıyor...', 'Checking the chain...') : t('Mührü Yeniden Doğrula', 'Verify the Seal Again')}</span>
          </button>
        </div>

        {verifyResult && (
          <div className="mt-5 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
            <div className="flex items-center gap-2 font-bold text-slate-800 mb-1">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span>{t(verifyResult.message, verifyResult.verified
                ? 'The stored audit chain links and audit data covered by the hashes were verified. This check covers audit records only.'
                : 'An inconsistency was found in the stored audit chain links or the audit data covered by the hashes.')}</span>
            </div>
            <p className="text-slate-500 font-mono">
              {t('Doğrulanan Toplam Kriptografik Kayıt: ', 'Total Cryptographic Records Verified: ')}<strong>{verifyResult.totalRecordsVerified}</strong>{t(' adet', ' records')}
            </p>
          </div>
        )}
      </div>

      {/* Güvenlik Mimarisi Bilgi Kutuları */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h4 className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
            <KeyRound className="h-4 w-4 text-blue-600" />
            <span>{t('AES-256-GCM Alan Şifreleme', 'AES-256-GCM Field Encryption')}</span>
          </h4>
          <p className="text-slate-500">
            {t('Fatura tutarları, bütçeler ve banka IBAN bilgileri veritabanında asla açık metin olarak durmaz. Askeri seviyede şifrelidir.', 'Invoice amounts, budgets, and bank IBANs are encrypted in the database.')}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h4 className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
            <RefreshCw className="h-4 w-4 text-emerald-600" />
            <span>{t('HMAC-SHA256 Kör İndeks', 'HMAC-SHA256 Blind Index')}</span>
          </h4>
          <p className="text-slate-500">
            {t('Arama ve filtrelemeler şifreli veriyi açığa çıkarmadan, tek yönlü tuzlanmış hash indeksleri üzerinden milisaniyeler içinde yapılır.', 'Search and filters use one-way salted hash indexes to return results in milliseconds without exposing encrypted data.')}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h4 className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-purple-600" />
            <span>{t('Çift Yönlü Oto-Kasa Mahsubu', 'Double-Entry Cash Offsets')}</span>
          </h4>
          <p className="text-slate-500">
            {t('Ortakların ve şantiyecilerin cebinden yaptığı harcamalar için çift taraflı muhasebe fişi anında kesilir ve canlı köprülerle bağlanır.', 'Out-of-pocket expenses paid by partners or site workers automatically generate linked double-entry accounting records.')}
          </p>
        </div>
      </div>
    </div>
  );
};
