import React, { useRef, useState } from 'react';
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
import { useLocale } from '../context/LocaleContext.js';

interface UniversalExcelModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImportComplete: () => Promise<void>;
  selectedProjectId?: string | null;
}

type ImportSource = { base64: string; sheetsUrl?: never } | { sheetsUrl: string; base64?: never };
type ImportMapping = {
  dateCol: number; titleCol: number; amountCol: number; categoryCol: number;
  subCategoryCol: number; partyCol: number; isPaidCol: number; payerPersonCol: number;
  currencyCol: number; accountFromCol: number; exchangeRateCol: number;
};

export function mapImportHeaders(headers: string[]): ImportMapping {
  const mapping: ImportMapping = { dateCol: -1, titleCol: -1, amountCol: -1, categoryCol: -1, subCategoryCol: -1, partyCol: -1, isPaidCol: -1, payerPersonCol: -1, currencyCol: -1, accountFromCol: -1, exchangeRateCol: -1 };
  headers.forEach((header, idx) => {
    const h = String(header).toLowerCase();
    if (h.includes('tarih') || h.includes('date')) mapping.dateCol = idx;
    if (h.includes('başlık') || h.includes('kalem') || h.includes('açıklama') || h.includes('title')) mapping.titleCol = idx;
    if (h.includes('tutar') || h.includes('bedel') || h.includes('fiyat') || h.includes('amount')) mapping.amountCol = idx;
    if (h.includes('kategori') || h.includes('grup') || h.includes('category')) mapping.categoryCol = idx;
    if (h.includes('alt') || h.includes('kırılım')) mapping.subCategoryCol = idx;
    if (h.includes('cari') || h.includes('tedarikçi') || h.includes('firma') || h.includes('party')) mapping.partyCol = idx;
    if (h.includes('durum') || h.includes('ödendi') || h.includes('status') || h === 'paid') mapping.isPaidCol = idx;
    if (h.includes('şahıs') || h.includes('cebinden')) mapping.payerPersonCol = idx;
  });
  return mapping;
}

export function validateImportColumnMapping(mapping: ImportMapping, columnCount: number): keyof ImportMapping | null {
  for (const key of ['dateCol', 'titleCol', 'amountCol'] as const) {
    if (!Number.isInteger(mapping[key]) || mapping[key] < 0 || mapping[key] >= columnCount) return key;
  }
  return null;
}

export const UniversalExcelModal: React.FC<UniversalExcelModalProps> = ({
  isOpen,
  onClose,
  onImportComplete,
  selectedProjectId,
}) => {
  const { t } = useLocale();
  const [activeTab, setActiveTab] = useState<'excel' | 'google_sheets'>('excel');
  const [fileName, setFileName] = useState('');
  const [sheetsUrl, setSheetsUrl] = useState('');

  // Analiz Sonuçları
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<any | null>(null);
  const [selectedSheetIndex, setSelectedSheetIndex] = useState(0);

  // Sütun Eşleştirmeleri (Mapping)
  const [dateCol, setDateCol] = useState<number>(-1);
  const [titleCol, setTitleCol] = useState<number>(-1);
  const [amountCol, setAmountCol] = useState<number>(-1);
  const [categoryCol, setCategoryCol] = useState<number>(-1);
  const [subCategoryCol, setSubCategoryCol] = useState<number>(-1);
  const [partyCol, setPartyCol] = useState<number>(-1);
  const [isPaidCol, setIsPaidCol] = useState<number>(-1);
  const [payerPersonCol, setPayerPersonCol] = useState<number>(-1);
  const [currencyCol, setCurrencyCol] = useState(-1);
  const [accountFromCol, setAccountFromCol] = useState(-1);
  const [exchangeRateCol, setExchangeRateCol] = useState(-1);
  const [skippedRows, setSkippedRows] = useState<Array<{ rowNumber: number; code: string }>>([]);
  const exporting = useRef(false);
  const analysisGeneration = useRef(0);
  const [analyzedSource, setAnalyzedSource] = useState<ImportSource | null>(null);

  const [isExecuting, setIsExecuting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const applyMapping = (headers: string[]) => {
    const m = mapImportHeaders(headers);
    setDateCol(m.dateCol); setTitleCol(m.titleCol); setAmountCol(m.amountCol);
    setCategoryCol(m.categoryCol); setSubCategoryCol(m.subCategoryCol); setPartyCol(m.partyCol);
    setIsPaidCol(m.isPaidCol); setPayerPersonCol(m.payerPersonCol);
    setCurrencyCol(m.currencyCol); setAccountFromCol(m.accountFromCol); setExchangeRateCol(m.exchangeRateCol);
  };

  const invalidateAnalysis = () => {
    analysisGeneration.current++;
    setIsAnalyzing(false);
    setAnalysis(null);
    setAnalyzedSource(null);
    setResultMessage(null);
    setSkippedRows([]);
    applyMapping([]);
  };

  const handleClose = () => {
    if (exporting.current) return;
    invalidateAnalysis();
    setFileName(''); setSheetsUrl(''); setError('');
    onClose();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    invalidateAnalysis();
    const generation = analysisGeneration.current;
    setFileName(file.name);
    setError('');
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = reader.result as string;
      if (generation !== analysisGeneration.current) return;
      await analyzeWorkbook({ base64: b64 });
    };
    reader.onerror = () => { if (generation === analysisGeneration.current) setError(t('Dosya okunamadı.', 'Could not read the file.')); };
    reader.readAsDataURL(file);
  };

  const handleAnalyzeUrl = async () => {
    if (!sheetsUrl.trim()) return;
    await analyzeWorkbook({ sheetsUrl: sheetsUrl.trim() });
  };

  const analyzeWorkbook = async (source: ImportSource) => {
    invalidateAnalysis();
    const generation = analysisGeneration.current;
    try {
      setIsAnalyzing(true);
      setError('');
      const res = await ApiClient.analyzeImport(source);
      if (generation !== analysisGeneration.current) return;

      setAnalysis(res);
      setAnalyzedSource(source);
      setSelectedSheetIndex(0);
      applyMapping(res.sheets?.[0]?.headers || []);
    } catch (err: any) {
      if (generation === analysisGeneration.current) setError(err.message || t('Dosya analiz edilemedi.', 'Could not analyze the file.'));
    } finally {
      if (generation === analysisGeneration.current) setIsAnalyzing(false);
    }
  };

  const handleExecuteImport = async () => {
    if (exporting.current || resultMessage) return;
    const currentSheet = analysis?.sheets?.[selectedSheetIndex];
    const mapping = { dateCol, titleCol, amountCol, categoryCol, subCategoryCol, partyCol, isPaidCol, payerPersonCol, currencyCol, accountFromCol, exchangeRateCol };
    if (!analyzedSource || !currentSheet || validateImportColumnMapping(mapping, currentSheet.headers?.length || 0)) {
      setError(t('Lütfen en azından Tarih, Başlık ve Tutar sütunlarını eşleştiriniz.', 'Map at least the Date, Title, and Amount columns.'));
      return;
    }

    try {
      exporting.current = true;
      setIsExecuting(true);
      setError('');

      const res = await ApiClient.executeImport({
        ...analyzedSource,
        sheetName: currentSheet.sheetName,
        sheetDigest: currentSheet.sheetDigest,
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
          currencyCol: currencyCol >= 0 ? currencyCol : undefined,
          accountFromCol: accountFromCol >= 0 ? accountFromCol : undefined,
          exchangeRateCol: exchangeRateCol >= 0 ? exchangeRateCol : undefined,
        },
      });

      setResultMessage(typeof res.importedCount === 'number'
        ? t(res.message, `Imported ${res.importedCount} expense ${res.importedCount === 1 ? 'record' : 'records'}.`)
        : res.message);
      setSkippedRows(Array.isArray(res.skippedRows) ? res.skippedRows : []);
      if (res.importedCount > 0) await onImportComplete();
    } catch (err: any) {
      setError(err.message || t('İçe aktarma sırasında bir hata oluştu.', 'An error occurred during import.'));
    } finally {
      exporting.current = false;
      setIsExecuting(false);
    }
  };

  const currentSheet = analysis?.sheets?.[selectedSheetIndex];
  const headers = currentSheet?.headers || [];
  const previewRows = currentSheet?.preview || [];

  const skippedRowReason = (code: string) => {
    const reasons: Record<string, [string, string]> = {
      TITLE_REQUIRED: ['Başlık boş olamaz.', 'A title is required.'],
      AMOUNT_REQUIRED: ['Tutar boş olamaz.', 'An amount is required.'],
      AMOUNT_INVALID: ['Tutar biçimi geçersiz.', 'The amount format is invalid.'],
      AMOUNT_PRECISION: ['Tutar en fazla iki ondalık basamak içerebilir.', 'The amount can have at most two decimal places.'],
      AMOUNT_AMBIGUOUS: ['Tutar ayraçları belirsiz.', 'The amount separators are ambiguous.'],
      DATE_INVALID: ['Tarih geçersiz veya belirsiz.', 'The date is invalid or ambiguous.'],
      CURRENCY_INVALID: ['Para birimi geçersiz veya desteklenmiyor.', 'The currency is invalid or unsupported.'],
      CURRENCY_CONFLICT: ['Tutar ve para birimi alanları uyuşmuyor.', 'The amount and currency fields conflict.'],
      EXCHANGE_RATE_REQUIRED: ['Farklı para birimleri için döviz kuru sütununu eşleyin.', 'Map an exchange rate column for different currencies.'],
      EXCHANGE_RATE_INVALID: ['Döviz kuru pozitif ve geçerli olmalıdır.', 'The exchange rate must be positive and valid.'],
      PAYMENT_INVALID: ['Ödeme durumu tanınmadı.', 'The payment status is not recognized.'],
      PAYMENT_ACCOUNT_REQUIRED: ['Ödenmiş şirket gideri için ödeme hesabı gerekir.', 'A paid company expense requires a payment account.'],
      PAYMENT_ACCOUNT_INVALID: ['Ödeme hesabı geçersiz, pasif, kapsam dışı veya para birimiyle uyumsuz.', 'The payment account is invalid, inactive, out of scope, or uses another currency.'],
      PAYMENT_SOURCE_CONFLICT: ['Şahıs ödemesi ve şirket hesabı aynı satırda birlikte seçilemez.', 'A personal payer and company account cannot be selected on the same row.'],
    };
    const reason = reasons[code] || ['Satırdaki değerler geçersiz.', 'The row contains invalid values.'];
    return t(reason[0], reason[1]);
  };


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
              <h3 className="text-sm font-bold text-slate-900">{t('Evrensel Excel & Google E-Tablolar Aktarıcısı', 'Universal Excel & Google Sheets Importer')}</h3>
              <p className="text-[11px] text-slate-500">{t('Herhangi bir tablonun sütunlarını eşleyerek anında şifreli olarak içeri aktarın', 'Map spreadsheet columns to import the data with encryption.')}</p>
            </div>
          </div>

          <button onClick={handleClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Sekmeler: Excel vs Google Sheets */}
        <div className="p-6 overflow-y-auto space-y-5 text-xs">
          <div className="flex rounded-xl bg-slate-100 p-1 border border-slate-200 max-w-md mx-auto">
            <button
              disabled={isExecuting}
              onClick={() => {
                invalidateAnalysis();
                setActiveTab('excel');
                setError('');
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg font-bold transition ${
                activeTab === 'excel' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" />
              <span>{t('Excel Dosyası (.xlsx, .xls)', 'Excel File (.xlsx, .xls)')}</span>
            </button>

            <button
              disabled={isExecuting}
              onClick={() => {
                invalidateAnalysis();
                setActiveTab('google_sheets');
                setFileName('');
                setError('');
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg font-bold transition ${
                activeTab === 'google_sheets' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Globe className="h-4 w-4" />
              <span>{t('Google E-Tablolar (Sheets)', 'Google Sheets')}</span>
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

          {skippedRows.length > 0 && (
            <section aria-label={t('Atlanan satırlar', 'Skipped rows')} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
              <p role="status" className="font-semibold">{t(`Atlanan satır: ${skippedRows.length}`, `Skipped rows: ${skippedRows.length}`)}</p>
              <ul className="mt-2 max-h-40 overflow-auto">
                {skippedRows.map(row => <li key={row.rowNumber}>{t('Satır', 'Row')} {row.rowNumber}: {skippedRowReason(row.code)}</li>)}
              </ul>
              <p className="mt-2">{t('Yeniden aktarmadan önce yalnız atlanan satırları düzeltip ayrı bir dosyaya alın.', 'Correct and separate the skipped rows before importing again.')}</p>
            </section>
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
                    {fileName ? fileName : t('Excel dosyasını buraya sürükleyin veya seçin', 'Drag an Excel file here or select one')}
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1">{t('.xlsx, .xls veya .csv formatı desteklenir', 'Supports .xlsx, .xls, and .csv files')}</p>
                </div>
              ) : (
                <div className="p-5 bg-blue-50/60 border border-blue-200 rounded-2xl space-y-3">
                  <label className="block text-slate-800 font-bold">{t('Google E-Tablo Web\'de Yayınlanan CSV veya Export Linki:', 'Published CSV or Export Link for Google Sheets:')}</label>
                  <input
                    type="url"
                    placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv"
                    value={sheetsUrl}
                    onChange={(e) => { invalidateAnalysis(); setSheetsUrl(e.target.value); setError(''); }}
                    className="w-full bg-white border border-slate-300 rounded-xl px-3.5 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                  <div className="text-[11px] text-slate-500 space-y-1">
                    <p>💡 <strong>{t('Nasıl Link Alınır?:', 'How to Get a Link:')}</strong>{t(' Google E-Tablonuzda ', ' In Google Sheets, choose ')}<em>{t('Dosya > Paylaş > Web\'de Yayınla > CSV', 'File > Share > Publish to web > CSV')}</em>{t(' seçip linki buraya yapıştırın.', ' and paste the link here.')}</p>
                  </div>
                  <button
                    onClick={handleAnalyzeUrl}
                    disabled={isAnalyzing || !sheetsUrl.trim()}
                    className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
                  >
                    {isAnalyzing ? t('Taranıyor...', 'Scanning...') : t('Tabloyu Tara ve Eşleştir', 'Scan Sheet and Map Columns')}
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
                  <span className="font-bold text-slate-700">{t('Sayfa:', 'Sheet:')}</span>
                  <select
                    value={selectedSheetIndex}
                    disabled={isExecuting}
                    onChange={(e) => {
                      const index = Number(e.target.value);
                      setSelectedSheetIndex(index);
                      applyMapping(analysis.sheets[index]?.headers || []);
                    }}
                    className="bg-white border border-slate-300 rounded-lg px-2.5 py-1 text-slate-800 font-semibold focus:outline-none"
                  >
                    {analysis.sheets.map((s: any, idx: number) => (
                      <option key={idx} value={idx}>
                        {s.sheetName} ({s.totalRows}{t(' satır)', ' rows)')}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  disabled={isExecuting}
                  onClick={invalidateAnalysis}
                  className="text-xs text-blue-600 hover:underline font-semibold"
                >
                  {t('Başka Dosya Seç', 'Choose Another File')}
                </button>
              </div>

              {/* Sütun Eşleştirme Izgarası */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-3">
                <h4 className="font-bold text-slate-900 text-xs">{t('Sütun Eşleştirmelerini Onaylayın:', 'Confirm Column Mapping:')}</h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Tarih Sütunu *', 'Date Column *')}</label>
                    <select
                      value={dateCol}
                      onChange={(e) => setDateCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value={-1}>{t('-- Sütun seçin --', '-- Select a column --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Harcama Başlığı / Kalem *', 'Expense Title / Item *')}</label>
                    <select
                      value={titleCol}
                      onChange={(e) => setTitleCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value={-1}>{t('-- Sütun seçin --', '-- Select a column --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Tutar Sütunu *', 'Amount Column *')}</label>
                    <select
                      value={amountCol}
                      onChange={(e) => setAmountCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none font-bold"
                    >
                      <option value={-1}>{t('-- Sütun seçin --', '-- Select a column --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Ana Kategori Sütunu', 'Parent Category Column')}</label>
                    <select
                      value={categoryCol}
                      onChange={(e) => setCategoryCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">{t('-- Eşleştirme (Genel Harcamalar) --', '-- Unmapped (General Expenses) --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Alt Kategori Sütunu', 'Subcategory Column')}</label>
                    <select
                      value={subCategoryCol}
                      onChange={(e) => setSubCategoryCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">{t('-- Alt Kategori Yok --', '-- No Subcategory --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Tedarikçi / Cari Sütunu', 'Supplier / Counterparty Column')}</label>
                    <select
                      value={partyCol}
                      onChange={(e) => setPartyCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">{t('-- Cari Sütunu Yok --', '-- No Counterparty Column --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Ödeme Durumu (Peşin/Vadeli)', 'Payment Status (Paid / On Credit)')}</label>
                    <select
                      value={isPaidCol}
                      onChange={(e) => setIsPaidCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">{t('-- Ödenmemiş say --', '-- Treat as unpaid --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-700 font-semibold mb-1">{t('Cebinden Ödeyen', 'Person Who Paid')}</label>
                    <select
                      value={payerPersonCol}
                      onChange={(e) => setPayerPersonCol(Number(e.target.value))}
                      className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-900 font-medium focus:outline-none"
                    >
                      <option value="-1">{t('-- Şahıs ödemesi yok --', '-- No personal payer --')}</option>
                      {headers.map((h: string, idx: number) => (
                        <option key={idx} value={idx}>{t(`${idx + 1}. Sütun: `, `Column ${idx + 1}: `)}{h || t(`(Kolon ${idx + 1})`, `(Column ${idx + 1})`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <label>{t('Para birimi sütunu', 'Currency column')}
                  <select value={currencyCol} onChange={event => setCurrencyCol(Number(event.target.value))} className="mt-1 block w-full rounded border p-2">
                    <option value={-1}>{t('Tutar işareti veya proje para birimi', 'Amount marker or project currency')}</option>
                    {headers.map((header: string, index: number) => <option key={index} value={index}>{header || index + 1}</option>)}
                  </select>
                </label>
                <label>{t('Döviz kuru sütunu', 'Exchange rate column')}
                  <select value={exchangeRateCol} onChange={event => setExchangeRateCol(Number(event.target.value))} className="mt-1 block w-full rounded border p-2">
                    <option value={-1}>{t('Aynı para biriminde otomatik 1', 'Automatic 1 for matching currencies')}</option>
                    {headers.map((header: string, index: number) => <option key={index} value={index}>{header || index + 1}</option>)}
                  </select>
                </label>
                <label>{t('Ödeme hesabı kimliği sütunu', 'Payment account ID column')}
                  <select value={accountFromCol} onChange={event => setAccountFromCol(Number(event.target.value))} className="mt-1 block w-full rounded border p-2">
                    <option value={-1}>{t('Hesap sütunu yok', 'No account column')}</option>
                    {headers.map((header: string, index: number) => <option key={index} value={index}>{header || index + 1}</option>)}
                  </select>
                </label>
              </div>
              <p>{t('Farklı para birimindeki giderler için kur, işlem para biriminin bir biriminin proje para birimindeki değeri olarak girilmelidir (ör. 1 USD = 0,92 EUR için 0,92). Ödeme durumu boşsa gider ödenmemiş sayılır.', 'For different currencies, enter the project-currency value of one unit of the transaction currency (for example, 0.92 for 1 USD = 0.92 EUR). A blank payment status is treated as unpaid.')}</p>

              {/* Canlı Örnek Satırlar Önizlemesi */}
              {previewRows.length > 0 && (
                <div className="space-y-1.5">
                  <span className="font-bold text-slate-800 text-xs">{t('Tablodan Örnek İlk Satırlar:', 'Sample Rows From the Sheet:')}</span>
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-left text-[11px] border-collapse">
                      <thead>
                        <tr className="bg-slate-100 text-slate-600 font-semibold border-b border-slate-200">
                          {headers.map((h: string, i: number) => (
                            <th key={i} className="py-2 px-3 whitespace-nowrap">
                              {h || t(`Kolon ${i + 1}`, `Column ${i + 1}`)}
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
                  onClick={handleClose}
                  className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold"
                >
                  {t('Vazgeç', 'Cancel')}
                </button>

                <button
                  type="button"
                  disabled={isExecuting || resultMessage !== null}
                  onClick={handleExecuteImport}
                  className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold transition shadow-sm disabled:opacity-50 flex items-center gap-2"
                >
                  <UploadCloud className="h-4 w-4" />
                  <span>{isExecuting ? t('Şifrelenerek Aktarılıyor...', 'Encrypting and importing...') : t(`${currentSheet?.totalRows} Satırı İçe Aktar`, `Import ${currentSheet?.totalRows} Rows`)}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
