import React, { useState } from 'react';
import { ShieldCheck, ShieldAlert, RefreshCw, KeyRound, CheckCircle2 } from 'lucide-react';
import { ApiClient } from '../api/client.js';

interface AuditViewProps {
  auditVerified: boolean | null;
  onRefreshAudit: () => Promise<void>;
}

export const AuditView: React.FC<AuditViewProps> = ({ auditVerified, onRefreshAudit }) => {
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
                    ? 'Kriptografik SHA-256 Denetim Zinciri Doğrulandı'
                    : 'UYARI: Denetim Zincirinde Uyuşmazlık'}
                </h3>
                <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                  Zero-Knowledge
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-1 max-w-2xl">
                Sistemdeki her mali hareket, kategori ve kasa işlemi, önceki satırın hash değeriyle kriptografik olarak birbirine bağlanır.
                Veritabanı sunucusuna yetkisiz girilip tek bir kuruş veya açıklama harici değiştirilse bile zincir bozulur ve sistem anında alarm verir.
              </p>
            </div>
          </div>

          <button
            onClick={handleVerifyNow}
            disabled={isVerifying}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isVerifying ? 'animate-spin' : ''}`} />
            <span>{isVerifying ? 'Zincir Taranıyor...' : 'Mührü Yeniden Doğrula'}</span>
          </button>
        </div>

        {verifyResult && (
          <div className="mt-5 p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs">
            <div className="flex items-center gap-2 font-bold text-slate-800 mb-1">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span>{verifyResult.message}</span>
            </div>
            <p className="text-slate-500 font-mono">
              Doğrulanan Toplam Kriptografik Kayıt: <strong>{verifyResult.totalRecordsVerified}</strong> adet
            </p>
          </div>
        )}
      </div>

      {/* Güvenlik Mimarisi Bilgi Kutuları */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h4 className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
            <KeyRound className="h-4 w-4 text-blue-600" />
            <span>AES-256-GCM Alan Şifreleme</span>
          </h4>
          <p className="text-slate-500">
            Fatura tutarları, bütçeler ve banka IBAN bilgileri veritabanında asla açık metin olarak durmaz. Askeri seviyede şifrelidir.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h4 className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
            <RefreshCw className="h-4 w-4 text-emerald-600" />
            <span>HMAC-SHA256 Kör İndeks</span>
          </h4>
          <p className="text-slate-500">
            Arama ve filtrelemeler şifreli veriyi açığa çıkarmadan, tek yönlü tuzlanmış hash indeksleri üzerinden milisaniyeler içinde yapılır.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <h4 className="font-bold text-slate-900 mb-1 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-purple-600" />
            <span>Çift Yönlü Oto-Kasa Mahsubu</span>
          </h4>
          <p className="text-slate-500">
            Ortakların ve şantiyecilerin cebinden yaptığı harcamalar için çift taraflı muhasebe fişi anında kesilir ve canlı köprülerle bağlanır.
          </p>
        </div>
      </div>
    </div>
  );
};
