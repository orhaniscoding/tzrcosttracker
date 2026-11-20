import React, { useState } from 'react';
import {
  ShieldCheck,
  Download,
  Upload,
  Lock,
  KeyRound,
  FileCheck,
  CheckCircle2,
  AlertTriangle,
  Cloud,
  HardDrive,
  RefreshCw,
  FolderSync,
} from 'lucide-react';
import { ApiClient } from '../api/client.js';
import { useLocale } from '../context/LocaleContext.js';

interface BackupCenterViewProps {
  onRestored: () => Promise<void>;
}

export const BackupCenterView: React.FC<BackupCenterViewProps> = ({ onRestored }) => {
  const { t } = useLocale();
  // Export State
  const [exportPassword, setExportPassword] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportV2Password, setExportV2Password] = useState('');
  const exportV2PasswordBytes = new TextEncoder().encode(exportV2Password).length;

  // Import State
  const [importPassword, setImportPassword] = useState('');
  const [importFileContent, setImportFileContent] = useState<string | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Otomatik Yedek Ayarları State
  const [autoBackupEnabled, setAutoBackupEnabled] = useState(true);
  const [autoBackupFrequency, setAutoBackupFrequency] = useState('daily');

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!exportPassword || exportPassword.length < 6) {
      setError(t('Yedekleme şifresi en az 6 karakter olmalıdır.', 'The backup password must be at least 6 characters long.'));
      return;
    }

    try {
      setIsExporting(true);
      setError('');
      setExportNotice(null);

      const res = await ApiClient.exportBackup(exportPassword);

      // .tzrvault dosyasını indir
      const blob = new Blob([res.vaultData], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = res.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setExportNotice(t(`Şifreli sistem yedeği başarıyla oluşturuldu ve indirildi! (${res.recordCounts.transactions} hareket, ${res.recordCounts.categories} kategori)`, `The encrypted system backup was created and downloaded (${res.recordCounts.transactions} transactions, ${res.recordCounts.categories} categories).`));
      setExportPassword('');
    } catch (err: any) {
      setError(err.message || t('Yedek oluşturulamadı.', 'Could not create the backup.'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportV2 = async (e: React.FormEvent) => {
    e.preventDefault();
    const passwordBytes = exportV2PasswordBytes;
    if (passwordBytes < 12 || passwordBytes > 256) {
      setError(t('V2 yedek parolası 12-256 UTF-8 bayt arasında olmalıdır.', 'The V2 backup password must be 12–256 UTF-8 bytes.'));
      return;
    }

    try {
      setIsExporting(true);
      setError('');
      setExportNotice(null);

      const res = await ApiClient.exportFullBackupV2(exportV2Password);
      const blob = new Blob([res.vaultData], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = res.filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setExportNotice(t(`Tam v2 sistem yedeği indirildi (${res.manifest.totalRows} kayıt, 11 tablo).`, `The full V2 system backup was downloaded (${res.manifest.totalRows} records, 11 tables).`));
      setExportV2Password('');
    } catch (err: any) {
      setError(err.message || t('V2 yedek oluşturulamadı.', 'Could not create the V2 backup.'));
    } finally {
      setIsExporting(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportFileName(file.name);
    setError('');

    const reader = new FileReader();
    reader.onload = () => {
      setImportFileContent(reader.result as string);
    };
    reader.readAsText(file);
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importFileContent || !importPassword) {
      setError(t('Lütfen yedek dosyasını seçin ve şifresini girin.', 'Select a backup file and enter its password.'));
      return;
    }

    if (!confirm(t('DİKKAT: Yedekten geri yükleme mevcut verilerinizin üzerine yazacaktır.\nDevam etmek istediğinize emin misiniz?', 'WARNING: Restoring from a backup will overwrite your existing data.\nAre you sure you want to continue?'))) {
      return;
    }

    try {
      setIsImporting(true);
      setError('');
      setImportNotice(null);

      const res = await ApiClient.importBackup({
        backupPassword: importPassword,
        vaultData: importFileContent.trim(),
      });

      setImportNotice(res.message && t(res.message, 'The V1 backup restored five tables. Full system recovery is unavailable with this format.'));
      setImportPassword('');
      setImportFileContent(null);
      setImportFileName('');
      await onRestored();
    } catch (err: any) {
      setError(err.message || t('Yedek yüklenemedi. Şifrenin doğru olduğundan emin olun.', 'Could not restore the backup. Make sure the password is correct.'));
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl">
      {/* BAŞLIK KARTI */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-purple-100 text-purple-700 flex items-center justify-center font-bold">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">
              {t('Askeri Düzeyde Sıfır-Bilgi Şifreli Yedekleme (.tzrvault)', 'Zero-Knowledge Encrypted Backup (.tzrvault)')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {t('Tüm harcamalar, cariler, kategoriler, firma ayarları ve kriptografik denetim loglarını AES-256-GCM ile parola korumalı tek dosyada arşivleyin', 'Archive expenses, counterparties, categories, company settings, and cryptographic audit logs in a single password-protected AES-256-GCM file.')}
            </p>
          </div>
        </div>

        {error && (
          <div className="mt-4 p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* SOL: YEDEK DIŞA AKTAR */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm border-b border-slate-200 pb-3">
            <Download className="h-5 w-5 text-blue-600" />
            <span>{t('Eski Biçim Şifreli Yedek V1 İndir', 'Download Legacy Encrypted V1 Backup')}</span>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            {t('Legacy v1 biçimidir; tam sistem kurtarma sağlamaz ve importer yalnızca beş tabloyu kısmi olarak geri yükler. Belirleyeceğiniz parola ile ', 'The legacy V1 format provides a partial restore of five tables. Your password protects the backup with ')}<strong>AES-256-GCM</strong>{t(' ile şifrelenir. Parola kaybedilirse yedek açılamaz.', ' encryption. If you lose the password, you cannot open the backup.')}
          </p>

          <form onSubmit={handleExport} className="space-y-3.5 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                {t('Yedek Güvenlik Parolası Belirleyin *', 'Choose a Backup Password *')}
              </label>
              <input
                type="password"
                placeholder={t('En az 6 karakterli güçlü parola...', 'A strong password with at least 6 characters...')}
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 focus:outline-none focus:border-blue-600"
                required
              />
              <p className="text-[11px] text-amber-700 mt-1 font-medium">
                {t('⚠️ Bu parolayı bir yere not ediniz. Parola unutulursa yedek dosyası geri açılamaz.', '⚠️ Keep this password somewhere safe. You cannot open the backup if you forget it.')}
              </p>
            </div>

            <button
              type="submit"
              disabled={isExporting || exportPassword.length < 6}
              className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Download className="h-4 w-4" />
              <span>{isExporting ? t('Şifreleniyor ve Paketleniyor...', 'Encrypting and packaging...') : t('Eski Biçim Yedeği V1 İndir (.tzrvault)', 'Download Legacy V1 Backup (.tzrvault)')}</span>
            </button>
          </form>

          <form onSubmit={handleExportV2} className="border-t border-slate-200 pt-4 space-y-3 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">{t('Tam Sistem Yedeği V2', 'Full System Backup V2')}</label>
              <p className="text-slate-500 mb-2">{t('11 veritabanı tablosu ve uygulama anahtarlarını içerir; dosya ekleri dahil değildir. Geri yükleme/rekey akışı henüz bu ekranda sunulmuyor.', 'Includes 11 database tables and application keys. File attachments are excluded. Restore and rekey are currently unavailable on this screen.')}</p>
              <p className="text-amber-700 mb-2">{t('V2 parolası 12-256 UTF-8 bayt olmalıdır. Parolayı kaybederseniz yedek açılamaz.', 'The V2 password must be 12–256 UTF-8 bytes. You cannot open the backup if you lose the password.')}</p>
              <input
                type="password"
                aria-label={t('V2 yedek parolası', 'V2 backup password')}
                placeholder={t('V2 için güçlü parola (12+ UTF-8 bayt)', 'Strong V2 password (12+ UTF-8 bytes)')}
                value={exportV2Password}
                onChange={(e) => setExportV2Password(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 focus:outline-none focus:border-blue-600"
                required
              />
            </div>
            <button
              type="submit"
              disabled={isExporting || exportV2PasswordBytes < 12 || exportV2PasswordBytes > 256}
              className="w-full py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <Download className="h-4 w-4" />
              <span>{isExporting ? t('Tam yedek şifreleniyor...', 'Encrypting the full backup...') : t('Tam Sistem Yedeği V2 İndir', 'Download Full System Backup V2')}</span>
            </button>
          </form>

          {exportNotice && (
            <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-emerald-900 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>{exportNotice}</span>
            </div>
          )}
        </div>

        {/* SAĞ: YEDEKTEN GERİ YÜKLE */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-slate-900 font-bold text-sm border-b border-slate-200 pb-3">
            <Upload className="h-5 w-5 text-purple-600" />
            <span>{t('V1 Biçimindeki Yedeği Kısmi Geri Yükle', 'Partially Restore a V1 Backup')}</span>
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            {t('Daha önce aldığınız ', 'Select a previously downloaded ')}<code>.tzrvault</code>{t(' dosyasını seçip parolasını girerek yalnız eski v1 biçimini kısmi olarak yükler; tam sistem kurtarma veya v2 restore değildir.', ' file and enter its password to partially restore a legacy V1 backup. Full system and V2 restores are unavailable here.')}
          </p>

          <form onSubmit={handleImport} className="space-y-3.5 text-xs">
            <div>
              <label className="block text-slate-700 font-semibold mb-1">{t('Yedek Dosyası (.tzrvault) *', 'Backup File (.tzrvault) *')}</label>
              <input
                type="file"
                accept=".tzrvault,.txt"
                onChange={handleFileSelect}
                className="w-full text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                required
              />
              {importFileName && (
                <span className="text-[11px] text-emerald-700 font-medium block mt-1">
                  {t('✓ Seçildi: ', '✓ Selected: ')}{importFileName}
                </span>
              )}
            </div>

            <div>
              <label className="block text-slate-700 font-semibold mb-1">{t('Yedek Açma Parolası *', 'Backup Password *')}</label>
              <input
                type="password"
                placeholder={t('Yedekleme sırasında belirlediğiniz parola...', 'The password you chose when creating the backup...')}
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-slate-900 focus:outline-none focus:border-purple-600"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isImporting || !importFileContent || !importPassword}
              className="w-full py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-white font-bold transition shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${isImporting ? 'animate-spin' : ''}`} />
              <span>{isImporting ? t('Çözülüyor ve Geri Yükleniyor...', 'Decrypting and restoring...') : t('V1 Kısmi Geri Yükleme', 'Partially Restore V1 Backup')}</span>
            </button>
          </form>

          {importNotice && (
            <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-emerald-900 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
              <span>{importNotice}</span>
            </div>
          )}
        </div>
      </div>

      {/* 3. OTOMATİK YEDEKLEME & BULUT DEPOLAMA REHBERİ */}
      <div className="bg-gradient-to-r from-slate-50 to-blue-50/50 border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 text-slate-900 font-bold text-sm">
          <Cloud className="h-5 w-5 text-blue-600" />
          <span>{t('3. Otomatik Yedekleme & Bulut Entegrasyonu (Google Drive / OneDrive)', '3. Automatic Backup & Cloud Integration (Google Drive / OneDrive)')}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
          <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
            <h4 className="font-bold text-slate-900 flex items-center gap-1.5">
              <FolderSync className="h-4 w-4 text-emerald-600" />
              <span>{t('Otomatik Zamanlama', 'Automatic Scheduling')}</span>
            </h4>
            <p className="text-slate-500 text-[11px]">
              {t('Sistem her gün gece 00:00\'da veya haftalık olarak yerel diske otomatik şifreli snapshot alır.', 'The system takes an encrypted snapshot on the local disk daily at midnight or weekly.')}
            </p>
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="autoBackup"
                checked={autoBackupEnabled}
                onChange={(e) => setAutoBackupEnabled(e.target.checked)}
                className="h-4 w-4 rounded text-blue-600"
              />
              <label htmlFor="autoBackup" className="font-semibold text-slate-700">{t('Otomatik Yedek Aktif', 'Automatic Backup Enabled')}</label>
            </div>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
            <h4 className="font-bold text-slate-900 flex items-center gap-1.5">
              <Cloud className="h-4 w-4 text-blue-600" />
              <span>Google Drive Sync</span>
            </h4>
            <p className="text-slate-500 text-[11px]">
              {t('İndirilen ', 'Save the downloaded ')}<code>.tzrvault</code>{t(' dosyalarını doğrudan Google Drive klasörünüze koyarak tam sıfır-bilgi güvenliği sağlayabilirsiniz.', ' files directly to your Google Drive folder to retain zero-knowledge protection.')}
            </p>
          </div>

          <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-2">
            <h4 className="font-bold text-slate-900 flex items-center gap-1.5">
              <HardDrive className="h-4 w-4 text-purple-600" />
              <span>OneDrive & Dropbox</span>
            </h4>
            <p className="text-slate-500 text-[11px]">
              {t('Şifrelenmiş yedek dosyasında hiçbir firma ismi ve tutar açık olmadığı için tüm bulut sağlayıcılarında %100 KVKK/GDPR uyumludur.', 'Company names and amounts are encrypted in the backup file before you upload it to a cloud provider.')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
