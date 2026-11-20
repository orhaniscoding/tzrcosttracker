import React, { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, Search, RefreshCw, KeyRound, Filter } from 'lucide-react';
import { ApiClient } from '../api/client.js';

interface AuditLogsViewProps {
  auditVerified: boolean | null;
  onRefreshAudit: () => Promise<void>;
}

export const AuditLogsView: React.FC<AuditLogsViewProps> = ({ auditVerified, onRefreshAudit }) => {
  const [logs, setLogs] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterAction, setFilterAction] = useState('all');
  const [isLoading, setIsLoading] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const fetchLogs = async () => {
    try {
      setIsLoading(true);
      const data = await ApiClient.getAuditLogs(150);
      setLogs(data);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const handleVerify = async () => {
    try {
      setIsVerifying(true);
      await onRefreshAudit();
      await fetchLogs();
    } finally {
      setIsVerifying(false);
    }
  };

  const filteredLogs = logs.filter((log) => {
    if (filterAction !== 'all' && log.action !== filterAction) return false;
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const entity = (log.entity || '').toLowerCase();
      const action = (log.action || '').toLowerCase();
      const diffStr = JSON.stringify(log.newState || {}).toLowerCase();
      if (!entity.includes(s) && !action.includes(s) && !diffStr.includes(s)) {
        return false;
      }
    }
    return true;
  });

  const getActionBadge = (action: string) => {
    switch (action) {
      case 'CREATE':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">Yeni Veri Girişi</span>;
      case 'UPDATE':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300">Güncelleme / Düzenleme</span>;
      case 'DELETE':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-300">Kayıt Silme</span>;
      case 'LOGIN':
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-700 border border-slate-300">Giriş Yapıldı</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-300">{action}</span>;
    }
  };

  return (
    <div className="space-y-6">
      {/* Üst Güvenlik Rozet Barı */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div
            className={`h-12 w-12 rounded-xl flex items-center justify-center shrink-0 border ${
              auditVerified === true
                ? 'bg-emerald-50 border-emerald-300 text-emerald-600'
                : 'bg-rose-50 border-rose-300 text-rose-600'
            }`}
          >
            {auditVerified === true ? <ShieldCheck className="h-7 w-7" /> : <ShieldAlert className="h-7 w-7" />}
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <span>Değiştirilemez Kriptografik Denetim Günlüğü (İşlem Logları)</span>
              <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-300 px-2 py-0.5 rounded-full">
                SHA-256 Zinciri Aktif
              </span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Google Tablonuzdaki "İŞLEM LOGLARI" sayfasının birebir modern karşılığıdır. Yapılan her ekleme, silme ve düzenleme kriptografik zincirle mühürlenir.
            </p>
          </div>
        </div>

        <button
          onClick={handleVerify}
          disabled={isVerifying}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-sm transition disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${isVerifying ? 'animate-spin' : ''}`} />
          <span>{isVerifying ? 'Mühür Doğrulanıyor...' : 'Zincir Bütünlüğünü Doğrula'}</span>
        </button>
      </div>

      {/* Arama ve Filtre Çubuğu */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-slate-700">Toplam {filteredLogs.length} Denetim Kaydı</span>

            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-slate-400" />
              <select
                value={filterAction}
                onChange={(e) => setFilterAction(e.target.value)}
                className="bg-white border border-slate-300 text-xs rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-blue-600 font-medium"
              >
                <option value="all">Tüm İşlem Türleri</option>
                <option value="CREATE">Yeni Veri Girişi (CREATE)</option>
                <option value="UPDATE">Güncelleme / Düzenleme (UPDATE)</option>
                <option value="DELETE">Kayıt Silme (DELETE)</option>
                <option value="LOGIN">Kullanıcı Girişi (LOGIN)</option>
              </select>
            </div>
          </div>

          <div className="relative min-w-[260px]">
            <Search className="h-3.5 w-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Log kayıtlarında ara..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white border border-slate-300 text-xs rounded-lg pl-8 pr-3 py-1.5 text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-600"
            />
          </div>
        </div>

        {/* Tablo */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider">
                <th className="py-2.5 px-3 w-36">İşlem Zamanı</th>
                <th className="py-2.5 px-3 w-28">İşlem Türü</th>
                <th className="py-2.5 px-3 w-32">Modül / Sayfa</th>
                <th className="py-2.5 px-3">Eski Değer</th>
                <th className="py-2.5 px-3">Yeni Değer & Değişiklik Özeti</th>
                <th className="py-2.5 px-3 w-36 text-center font-mono">Zincir Mührü</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 font-normal">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    Denetim logları yükleniyor...
                  </td>
                </tr>
              ) : filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-500">
                    Kayıtlı bir denetim hareketi bulunmuyor.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log, idx) => {
                  const dateFormatted = new Date(log.timestamp).toLocaleString('tr-TR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  });

                  return (
                    <tr key={log.id} className={`hover:bg-slate-50 transition ${idx % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'}`}>
                      <td className="py-2.5 px-3 font-mono text-slate-600 text-[11px] whitespace-nowrap">
                        {dateFormatted}
                      </td>

                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {getActionBadge(log.action)}
                      </td>

                      <td className="py-2.5 px-3 font-semibold text-slate-800">
                        {log.entity === 'transaction'
                          ? 'Harcama / Kasa'
                          : log.entity === 'category'
                          ? 'Kategori'
                          : log.entity === 'project'
                          ? 'Proje'
                          : log.entity}
                      </td>

                      <td className="py-2.5 px-3 text-slate-500 font-mono text-[11px] max-w-xs truncate">
                        {log.previousState ? JSON.stringify(log.previousState) : '-'}
                      </td>

                      <td className="py-2.5 px-3 font-medium text-slate-900 max-w-md truncate">
                        {log.newState ? JSON.stringify(log.newState) : '-'}
                      </td>

                      <td className="py-2.5 px-3 text-center font-mono text-[10px] text-slate-400">
                        <span title={log.hash}>
                          {log.hash.slice(0, 8)}...{log.hash.slice(-4)}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
