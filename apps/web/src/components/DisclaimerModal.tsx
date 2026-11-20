import { useLocale } from '../context/LocaleContext.js';
import React, { useState } from 'react';
import { AlertTriangle, ShieldAlert, Check, X } from 'lucide-react';

interface DisclaimerModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DisclaimerModal: React.FC<DisclaimerModalProps> = ({
  isOpen,
  onConfirm,
  onCancel,
}) => {
  const { t: copy } = useLocale();
  const [isChecked, setIsChecked] = useState(false);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 select-none">
      <div className="bg-white border-2 border-rose-500 rounded-3xl w-full max-w-lg p-6 shadow-2xl space-y-4">
        {/* Başlık */}
        <div className="flex items-center gap-3 text-rose-600">
          <div className="h-12 w-12 rounded-2xl bg-rose-100 flex items-center justify-center shrink-0">
            <ShieldAlert className="h-7 w-7 text-rose-600" />
          </div>
          <div>
            <h3 className="text-base font-black text-slate-900">{copy("YASAL GÜVENLİK SORUMLULUK REDDİ", "Screen security notice")}</h3>
            <p className="text-xs text-rose-600 font-semibold">{copy("Hareketsizlik Kilit Sistemini Kapatma Onayı", "Confirm turning off the inactivity lock")}</p>
          </div>
        </div>

        {/* Uyarı Metni */}
        <div className="p-4 bg-rose-50/80 border border-rose-200 rounded-2xl text-xs text-slate-700 space-y-2 leading-relaxed">
          <p className="font-bold text-rose-900">
            {copy("🚨 DİKKAT: Ekran kilidini ve hareketsizlik zaman aşımını (Inactivity Timeout) tamamen devre dışı bırakmak üzeresiniz.", "Turning off the inactivity timeout keeps the session open while you are away.")}
          </p>
          <p>
            {copy("Bu ayar kapatıldığında, bilgisayarınızın başından ayrıldığınızda veya ekranınızı açık unuttuğunuzda şirketinizin tüm şifreli harcamaları, kasa nakit bakiyeleri, ortak alacakları ve cari bilgileri cihazınıza fiziksel erişimi olan herkes tarafından serbestçe görüntülenebilir ve değiştirilebilir.", "Anyone with access to your unlocked device can view or change records available to your account while the session is open.")}
          </p>
          <p className="text-[11px] text-slate-500 italic">
            {copy("Bu korumanın kapatılmasından kaynaklanabilecek veri sızıntısı, yetkisiz kayıt silme/değiştirme veya şirket içi güvenlik ihlallerinde tüm sorumluluk kullanıcıya aittir.", "Lock the screen before leaving your device unattended.")}
          </p>
        </div>

        {/* Onay Kutusu */}
        <label className="flex items-start gap-2.5 p-3 rounded-xl border border-slate-300 hover:bg-slate-50 cursor-pointer text-xs">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={(e) => setIsChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
          />
          <span className="text-slate-800 font-semibold">
            {copy("Bu ayarın doğurabileceği tüm yetkisiz erişim ve veri güvenliği risklerini", "I")} <strong>{copy("anladığımı, kabul ettiğimi", "understand and accept")}</strong> {copy("ve sorumluluğu üstlendiğimi beyan ederim.", "the risk of leaving the session open.")}
          </span>
        </label>

        {/* Butonlar */}
        <div className="pt-2 flex justify-end gap-2.5 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            {copy("Vazgeç (Kilidi Açık Tut)", "Keep inactivity lock")}
          </button>

          <button
            type="button"
            disabled={!isChecked}
            onClick={() => {
              setIsChecked(false);
              onConfirm();
            }}
            className="px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold transition shadow-sm disabled:opacity-40"
          >
            {copy("Anladım, Kilidi Kapat", "Turn off inactivity lock")}
          </button>
        </div>
      </div>
    </div>
  );
};
