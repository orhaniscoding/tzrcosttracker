import React, { useState } from 'react';
import {
  X,
  UploadCloud,
  FileSpreadsheet,
  Globe,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Table,
  Check,
} from 'lucide-react';
import { ApiClient } from '../api/client.js';

interface UniversalExcelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => Promise<void>;
  selectedProjectId?: string | null;
}

export const UniversalExcelModal: React.FC<UniversalExcelModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  selectedProjectId,
}) => {
  const [activeTab, setActiveTab] = useState<'excel' | 'google_sheets'>('excel');
  const [fileBase64, setFileBase64] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetsUrl, setSheetsUrl] = useState('');

  // Analiz Sonuçları
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<any | null>(null);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);

  // Sütun Eşleştirmeleri (Mapping)
  const [dateCol, setDateCol] = useState<number>(0);
  const [titleCol, setTitleCol] = useState<number>(1);
  const [amountCol, setAmountCol] = useState<number>(2);
  const [categoryCol, setCategoryCol] = useState<number>(-1);
  const [subCategoryCol, setSubCategoryCol] = useState<number>(-1);
  const [partyCol, setPartyCol] = useState<number>(-1);
  const [isPaidCol, setIsPaidCol] = useState<number>(-1);
  const [payerPersonCol, setPayerPersonCol] = useState<number>(-1);

  const [isExecuting, setIsExecuting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError('');
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result as string;
      setFileBase64(b64);
      await analyzeWorkbook(b64, undefined);
    };
    reader.readAsDataURL(file);
  };

  const handleAnalyzeUrl = async () => {
    if (!sheetsUrl.trim()) return;
    await analyzeWorkbook(undefined, sheetsUrl.trim());
  };

  const analyzeWorkbook = async (base64?: string, url?: string) => {
    try {
      setIsAnalyzing(true);
      setError('');
      setAnalysis(null);
      setResultMessage(null);

      const res = await ApiClient.analyzeImport({
        base64: base64 || fileBase64 || undefined,
        sheetsUrl: url || sheetsUrl || undefined,
      });

      setAnalysis(res);
      setSelectedSheetIndex(0);

      // Akıllı varsayılan sütun eşleştirmesi
      if (res.sheets?.[0]?.headers) {
        const headers: string[] = res.sheets[0].headers.map((h: string) => h.toLowerCase());
        headers.forEach((h, idx) => {
          if (h.includes('tarih') || h.includes('date')) setDateCol(idx);
          if (h.includes('başlık') || h.includes('kalem') || h.includes('açıklama') || h.includes('title')) setTitleCol(idx);
          if (h.includes('tutar') || h.includes('bedel') || h.includes('fiyat') || h.includes('amount')) setAmountCol(idx);
          if (h.includes('kategori') || h.includes('grup') || h.includes('category')) setCategoryCol(idx);
          if (h.includes('alt') || h.includes('kırılım')) setSubCategoryCol(idx);
          if (h.includes('cari') || h.includes('tedarikçi') || h.includes('firma') || h.includes('party')) setPartyCol(idx);
          if (h.includes('durum') || h.includes('ödendi') || h.includes('status')) setIsPaidCol(idx);
          if (h.includes('şahıs') || h.includes('cebinden') || h.includes('kasa')) setPayerPersonCol(idx);
        });
      }
    } catch (err: any) {
      setError(err.message || 'Dosya analiz edilemedi.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleExecuteImport = async () => {
    if (dateCol < 0 || titleCol < 0 || amountCol < 0) {
      setError('Lütfen en azından Tarih, Başlık ve Tutar sütunlarını eşleştiriniz.');
      return;
    }

    try {
      setIsExecuting(true);
      setError('');

      const currentSheet = analysis?.sheets?.[selectedSheetIndex];
      const res = await ApiClient.executeImport({
        base64: fileBase64 || undefined,
        sheetsUrl: sheetsUrl || undefined,
        sheetName: currentSheet?.sheetName,
        projectId: selectedProjectId || undefined,
        mapping: {
          dateCol,
          titleCol,
          amountCol,
          categoryCol: categoryCol >= 0 ? categoryCol : undefined,
          subCategoryCol: subCategoryCol >= 0 ? subCategoryCol : undefined,
          partyCol: partyCol >= 0 ? partyCol : undefined,
          isPaidCol: isPaidCol >= 0 ? isPaidCol : undefined,
          payerPersonCol: payerPersonCol >= 0 ? payerPersonCol : undefined,
        },
      });

      setResultMessage(res.message);
      await onImportComplete();
      setTimeout(() => {
        onClose();
      }, 2500);
    } catch (err: any) {
      setError(err.message || 'İçe aktarma sırasında bir hata oluştu.');
    } finally {
      setIsExecuting(false);
    }
  };

  const currentSheet = analysis?.sheets?.[selectedSheetIndex];
  const headers = currentSheet?.headers || [];
  const previewRows = currentSheet?.preview || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 select-none">
      <div className="bg-white border border-slate-200 rounded-3xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Başlık */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold">
              <UploadCloud className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Evrensel Excel & Google E-Tablolar Aktarıcısı</h3>
              <p className="text-[11px] text-slate-500">Herhangi bir tablonun sütunlarını eşleyerek anında şifreli olarak içeri aktarın</p>
            </div>
          </div>

          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Sekmeler: Excel vs Google Sheets */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs">
          <div className="flex rounded-xl bg-slate-100 p-1 border border-slate-200 max-w-md mx-auto">
            <button
              onClick={() => {
                setActiveTab('excel');
                setAnalysis(null);
                setError('');
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg font-bold transition ${
                activeTab === 'excel' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>Excel Dosyası (.xlsx, .xls)</span>
            </button>

            <button
              onClick={() => {
                setActiveTab('google_sheets');
                setAnalysis(null);
                setError('');
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg font-bold transition ${
                activeTab === 'google_sheets' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Globe className="h-4 w-4" />
              <span>Google E-Tablolar (Sheets)</span>
            </button>
          </div>

          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
              <span>{error}</span>
            </div>
          )}

          {resultMessage && (
            <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-emerald-900 font-bold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>{resultMessage}</span>
            </div>
          )}

          {/* 1. KAYNAK GİRİŞİ */}
          {!analysis && (
            <div className="space-y-4">
              {activeTab === 'excel' ? (
                <div className="border-2 border-dashed border-slate-300 rounded-3xl p-8 text-center hover:border-emerald-500 transition cursor-pointer relative bg-slate-50/50">
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileChange}
                    className="absolute inset-0 opacity-0 cursor-pointer"
                  />
                  <FileSpreadsheet className="h-10 w-10 text-emerald-600 mx-auto mb-2" />
                  <p className="font-bold text-slate-800 text-sm">
                    {fileName ? fileName : 'Excel dosyasını buraya sürükleyin veya seçin'}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1">.xlsx, .xls veya .csv formatı desteklenir</p>
                </div>
              ) : (
                <div className="p-5 bg-blue-50/60 border border-blue-200 rounded-2xl space-y-3">
                  <label className="block text-slate-800 font-bold">Google E-Tablo Web'de Yayınlanan CSV veya Export Linki:</label>
                  <input
                    type="url"
                    placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv"
                    value={sheetsUrl}
                    onChange={(e) => setSheetsUrl(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                  <div className="text-[11px] text-slate-500 space-y-1">
                    <p>💡 <strong>Nasıl Link Alınır?:</strong> Google E-Tablonuzda <em>Dosya &gt; Paylaş &gt; Web'de Yayınla &gt; CSV</em> seçip linki buraya yapıştırın.</p>
                  </div>
                  <button
                    onClick={handleAnalyzeUrl}
                    disabled={isAnalyzing || !sheetsUrl.trim()}
                    className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
                  >
                    {isAnalyzing ? 'Taranıyor...' : 'Tabloyu Tara ve Eşleştir'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 2. SÜTUN EŞLEŞTİRME VE ÖNİZLEME (ANALİZ SONRASI) */}
          {analysis && (
            <div className="space-y-4">
              {/* Sayfa Seçimi & Genel Bilgi */}
              <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-700">Sayfa:</span>
                  <select
                    value={selectedSheetIndex}
                    onChange={(e) => setSelectedSheetIndex(Number(e.target.value))}
                    className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-slate-800 font-semibold focus:outline-none"
                  >
                    {analysis.sheets.map((s: any, idx: number) => (
                      <option key={idx} value={idx}>
                        {s.sheetName} ({s.totalRows} satır)
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={() => setAnalysis(null)}
                  className="text-xs text-blue-600 hover:underline font-semibold"
                >
                  Başka Dosya Seç
                </button>
              </div>

              {/* Sütun Eşleştirme Izgarası */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
                <h4 className="font-bold text-slate-900 text-xs">Sütun Eşleştirmelerini Onaylayın:</h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Tarih Sütunu *</label>
                    <select
                      value={dateCol}
                      onChange={(e) => setDateCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Harcama Başlığı / Kalem *</label>
                    <select
                      value={titleCol}
                      onChange={(e) => setTitleCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Tutar Sütunu *</label>
                    <select
                      value={amountCol}
                      onChange={(e) => setAmountCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none font-bold"
                    >
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Ana Kategori Sütunu</label>
                    <select
                      value={categoryCol}
                      onChange={(e) => setCategoryCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">-- Eşleştirme (Genel Harcamalar) --</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Alt Kategori Sütunu</label>
                    <select
                      value={subCategoryCol}
                      onChange={(e) => setSubCategoryCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">-- Alt Kategori Yok --</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Tedarikçi / Cari Sütunu</label>
                    <select
                      value={partyCol}
                      onChange={(e) => setPartyCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">-- Cari Sütunu Yok --</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Ödeme Durumu (Peşin/Vadeli)</label>
                    <select
                      value={isPaidCol}
                      onChange={(e) => setIsPaidCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">-- Hepsi Peşin Ödendi --</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">Cebinden Ödeyen (Oto-Kasa)</label>
                    <select
                      value={payerPersonCol}
                      onChange={(e) => setPayerPersonCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">-- Hepsi Şirket Kasasından --</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{idx + 1}. Sütun: {h || `(Kolon ${idx + 1})`}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Canlı Örnek Satırlar Önizlemesi */}
              {previewRows.length > 0 && (
                <div className="space-y-1.5">
                  <span className="font-bold text-slate-800 text-xs">Tablodan Örnek İlk Satırlar:</span>
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left text-[11px] border-collapse">
                      <thead>
                        <tr className="bg-slate-100 text-slate-600 font-semibold border-b border-slate-200">
                          {headers.map((h: string, i: number) => (
                            <th key={i} className="py-2 px-3 whitespace-nowrap">
                              {h || `Kolon ${i + 1}`}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {previewRows.map((r: any[], rowIdx: number) => (
                          <tr key={rowIdx} className="hover:bg-slate-50">
                            {r.map((val: any, colIdx: number) => (
                              <td key={colIdx} className="py-1.5 px-3 whitespace-nowrap text-slate-800">
                                {val instanceof Date ? val.toISOString().split('T')[0] : String(val || '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* İçe Aktarma Butonu */}
              <div className="pt-3 border-t border-slate-200 flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  Vazgeç
                </button>

                <button
                  type="button"
                  disabled={isExecuting}
                  onClick={handleExecuteImport}
                  className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  <UploadCloud className="h-4 w-4" />
                  <span>{isExecuting ? 'Şifrelenerek Aktarılıyor...' : `${currentSheet?.totalRows} Satırı İçe Aktar`}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
