import React, { useState } from 'react';
import {
  Shield,
  Clock,
  Lock,
  KeyRound,
  AlertTriangle,
  CheckCircle2,
  Sliders,
  Check,
} from 'lucide-react';
import { DisclaimerModal } from './DisclaimerModal.js';
import { useLocale } from '../context/LocaleContext.js';

interface SecuritySettingsViewProps {
  timeoutSeconds: number;
  onUpdateTimeout: (seconds: number) => void;
  lockOnRefresh: boolean;
  onUpdateLockOnRefresh: (val: boolean) => void;
  onLockNow: () => void;
}

export const SecuritySettingsView: React.FC<SecuritySettingsViewProps> = ({
  timeoutSeconds,
  onUpdateTimeout,
  lockOnRefresh,
  onUpdateLockOnRefresh,
  onLockNow,
}) => {
  const { t } = useLocale();
  const [selectedTimeout, setSelectedTimeout] = useState<number>(timeoutSeconds);
  const [selectedRefreshLock, setSelectedRefreshLock] = useState<boolean>(lockOnRefresh);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [pendingZeroTimeout, setPendingZeroTimeout] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const handleTimeoutChange = (val: number) => {
    if (val === 0) {
      setPendingZeroTimeout(true);
      setShowDisclaimer(true);
    } else {
      setSelectedTimeout(val);
      onUpdateTimeout(val);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
    }
  };

  const handleConfirmDisclaimer = () => {
    setShowDisclaimer(false);
    setSelectedTimeout(0);
    onUpdateTimeout(0);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 3000);
  };

  const handleToggleRefreshLock = (val: boolean) => {
    setSelectedRefreshLock(val);
    onUpdateLockOnRefresh(val);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 3000);
  };

  const timeoutOptions = [
    { label: t('1 Dakika (Yüksek Güvenlik)', '1 Minute (High Security)'), value: 60 },
    { label: t('5 Dakika (Önerilen)', '5 Minutes (Recommended)'), value: 300 },
    { label: t('15 Dakika (Standart)', '15 Minutes (Standard)'), value: 900 },
    { label: t('30 Dakika (Ofis Ortamı)', '30 Minutes (Office)'), value: 1800 },
    { label: t('Asla Kapatma (Sorumluluk Onaylı)', 'Never Lock (Requires Acknowledgment)'), value: 0 },
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* BAŞLIK */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center font-bold">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">
                {t('Ekran Kilidi, Zaman Aşımı & Oturum Politikası', 'Screen Lock, Timeout & Session Policy')}
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {t('Şantiye veya ortak bilgisayarlarda hareketsizlik anında otomatik ekran kilitleme ayarları', 'Automatically lock an idle screen on site or on a shared computer.')}
              </p>
            </div>
          </div>

          <button
            onClick={onLockNow}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 hover:bg-black text-amber-300 border border-slate-700 text-xs font-bold transition shadow-sm"
          >
            <Lock className="h-4 w-4" />
            <span>{t('Şimdi Ekranı Kilitle', 'Lock Screen Now')}</span>
          </button>
        </div>

        {savedNotice && (
          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-300 rounded-xl text-emerald-900 text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>{t('Güvenlik politikası ayarları başarıyla kaydedildi!', 'Security policy settings saved.')}</span>
          </div>
        )}
      </div>

      {/* AYAR KARTLARI */}
      <div className="grid grid-cols-1 gap-6 text-xs">
        {/* KART 1: HAREKETSİZLİK ZAMAN AŞIMI */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2 font-bold text-sm text-slate-900">
              <Clock className="h-4 w-4 text-blue-600" />
              <span>{t('Hareketsizlik Zaman Aşımı (Inactivity Timeout)', 'Inactivity Timeout')}</span>
            </div>
            <span className={`px-2.5 py-0.5 rounded-full font-bold text-[11px] ${
              selectedTimeout === 0
                ? 'bg-rose-100 text-rose-800 border border-rose-300'
                : 'bg-emerald-100 text-emerald-800'
            }`}>
              {selectedTimeout === 0 ? t('Devre Dışı (Kilit Kapalı)', 'Disabled (Screen Lock Off)') : t(`${selectedTimeout / 60} Dakika`, `${selectedTimeout / 60} ${selectedTimeout === 60 ? 'Minute' : 'Minutes'}`)}
            </span>
          </div>

          <p className="text-slate-500 leading-relaxed">
            {t('Fare hareketi veya klavye tuşlaması olmadığında sistem ekranı otomatik olarak buzlar ve 4 haneli PIN girmeden hiçbir finansal veriyi göstermez.', 'The screen locks after a period without mouse or keyboard activity. Enter your 4-digit PIN to view financial data again.')}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            {timeoutOptions.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-center justify-between p-3.5 rounded-xl border cursor-pointer transition ${
                  selectedTimeout === opt.value
                    ? 'bg-blue-50/80 border-blue-500 shadow-sm'
                    : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="timeout"
                    checked={selectedTimeout === opt.value}
                    onChange={() => handleTimeoutChange(opt.value)}
                    className="text-blue-600"
                  />
                  <span className={`font-semibold ${selectedTimeout === opt.value ? 'text-blue-900' : 'text-slate-700'}`}>
                    {opt.label}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* KART 2: TARAYICI AÇILDIĞINDA / YENİLENDİĞİNDE KİLİT */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div className="flex items-center gap-2 font-bold text-sm text-slate-900">
              <KeyRound className="h-4 w-4 text-purple-600" />
              <span>{t('Tarayıcı Açılışında / Yenilenmesinde PIN Kalkanı', 'PIN Lock on Browser Startup or Refresh')}</span>
            </div>
          </div>

          <p className="text-slate-500 leading-relaxed">
            {t('Tarayıcı kapatılıp tekrar açıldığında veya sayfa yenilendiğinde tam oturum açık kalsa dahi ekrana doğrudan erişilmez; önce 4 haneli PIN ile kilit açılır.', 'When you reopen the browser or refresh the page, enter your 4-digit PIN to unlock the screen even if you are still signed in.')}
          </p>

          <label className="flex items-center justify-between p-4 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-100 transition">
            <div>
              <span className="font-bold text-slate-800 block text-sm">{t('Açılışta PIN Kilit Ekranını Zorunlu Kıl', 'Require PIN at Startup')}</span>
              <span className="text-[11px] text-slate-500">{t('Oturumu kapatmadan sayfayı yenilediğinizde PIN ister', 'Asks for your PIN when you refresh while signed in')}</span>
            </div>
            <input
              type="checkbox"
              checked={selectedRefreshLock}
              onChange={(e) => handleToggleRefreshLock(e.target.checked)}
              className="h-5 w-5 rounded text-blue-600"
            />
          </label>
        </div>

        {/* KART 3: BRUTE-FORCE KORUMASI */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5 space-y-2">
          <h4 className="font-bold text-slate-900 flex items-center gap-2">
            <Shield className="h-4 w-4 text-emerald-600" />
            <span>{t('Otomatik Kaba Kuvvet (Brute-Force) Kalkanı', 'Protection Against Repeated PIN Attempts')}</span>
          </h4>
          <p className="text-slate-500 text-[11px] leading-relaxed">
            {t('PIN kodu art arda ', 'If you enter the wrong PIN ')}<strong>{t('5 kez hatalı girilirse', '5 times in a row')}</strong>{t(' sistem otomatik olarak 5 dakikalık zorunlu bekleme moduna geçer. Bu sayede fiziksel olarak cihazın başına geçen kötü niyetli kişiler PIN tahmin edemez.', ' you must wait 5 minutes before trying again. This limits PIN guessing by someone with physical access to the device.')}
          </p>
        </div>
      </div>

      {/* YASAL SORUMLULUK REDDİ MODALI */}
      <DisclaimerModal
        isOpen={showDisclaimer}
        onConfirm={handleConfirmDisclaimer}
        onCancel={() => {
          setShowDisclaimer(false);
          setPendingZeroTimeout(false);
        }}
      />
    </div>
  );
};
