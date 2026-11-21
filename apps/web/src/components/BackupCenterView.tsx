import React, { useRef, useState } from 'react';
import { Download, Lock } from 'lucide-react';
import { ApiClient, ApiError } from '../api/client.js';
import { useLocale } from '../context/LocaleContext.js';

export function BackupCenterView() {
  const { t } = useLocale();
  const [password, setPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const passwordBytes = new TextEncoder().encode(password).length;

  async function exportBackup(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || passwordBytes < 12 || passwordBytes > 256) return;
    inFlight.current = true;
    setExporting(true);
    setError('');
    setNotice('');
    try {
      const backup = await ApiClient.exportFullBackupV2(password);
      const url = URL.createObjectURL(new Blob([backup.vaultData], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      try {
        link.href = url;
        link.download = backup.filename;
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      setPassword('');
      setNotice(t('Şifreli V2 yedeği indirildi.', 'Encrypted V2 backup downloaded.'));
    } catch (failure) {
      const code = failure instanceof ApiError ? failure.code : undefined;
      if (code === 'BACKUP_V2_LIMIT_EXCEEDED') {
        setError(t('V2 dışa aktarım kapasitesi aşıldı. Yedek almadan önce işletim kılavuzundaki sınırları kontrol edin.', 'The V2 export limit was exceeded. Check the limits in the operations guide.'));
      } else if (code === 'BACKUP_V2_ATTACHMENTS_UNAVAILABLE') {
        setError(t('V2 yedeği ek dosya içeren kayıtları desteklemiyor.', 'V2 backup does not support records with attachments.'));
      } else if (code === 'BACKUP_V2_RELATION_INVALID') {
        setError(t('Bağlı mali kayıtlar V2 geri yükleme kurallarını karşılamıyor.', 'Linked financial records do not meet the V2 restore requirements.'));
      } else {
        setError(t('V2 yedeği oluşturulamadı.', 'Could not create the V2 backup.'));
      }
    } finally {
      inFlight.current = false;
      setExporting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
          <Lock className="h-5 w-5 text-blue-600" aria-hidden="true" />
          {t('Tam Sistem Yedeği V2', 'Full System Backup V2')}
        </h2>
        <p className="text-sm text-slate-600">{t('Desteklenen veritabanı kayıtlarını parola korumalı bir .tzrvault dosyası olarak indirin. Ek dosyalar kapsam dışındadır.', 'Download supported database records as a password-protected .tzrvault file. Attachments are outside the backup scope.')}</p>
        <form onSubmit={exportBackup} className="space-y-3">
          <label htmlFor="v2-backup-password" className="block text-sm font-semibold">{t('V2 yedek parolası', 'V2 backup password')}</label>
          <input id="v2-backup-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2" aria-describedby="v2-backup-password-help" required />
          <p id="v2-backup-password-help" className="text-xs text-slate-600">{t('12–256 UTF-8 bayt uzunluğunda bir parola seçin. Parolayı yedek dosyasından ayrı saklayın.', 'Choose a password of 12–256 UTF-8 bytes. Store it separately from the backup file.')}</p>
          <button type="submit" disabled={exporting || passwordBytes < 12 || passwordBytes > 256} className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            <Download className="h-4 w-4" aria-hidden="true" />
            {exporting ? t('Yedek hazırlanıyor…', 'Preparing backup…') : t('V2 yedeğini indir', 'Download V2 backup')}
          </button>
        </form>
        {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      </section>
      <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
        <h3 className="font-semibold text-slate-900">{t('Yedekleri saklama ve geri yükleme', 'Storing and restoring backups')}</h3>
        <p>{t('Yedek takvimini operatör yönetir. Yedek dosyasının açılabildiğini ayrı bir deneme kurulumunda düzenli olarak doğrulayın.', 'The operator manages the backup schedule. Regularly verify that a backup can be restored to a separate test installation.')}</p>
        <p>{t('V2 geri yüklemesini uygulama kapalıyken çevrimdışı kurtarma aracıyla yapın. Eski V1 dosyalarını saklayın ve dönüştürme için operatöre başvurun.', 'Use the offline recovery tool with the application stopped to restore V2. Keep existing V1 files and ask the operator about conversion.')}</p>
      </section>
    </div>
  );
}
