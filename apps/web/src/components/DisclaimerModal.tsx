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
            <h3 className="text-base font-black text-slate-900">YASAL GÜVENLİK SORUMLULUK REDDİ</h3>
            <p className="text-xs text-rose-600 font-semibold">Hareketsizlik Kilit Sistemini Kapatma Onayı</p>
          </div>
        </div>

        {/* Uyarı Metni */}
        <div className="p-4 bg-rose-50/80 border border-rose-200 rounded-2xl text-xs text-slate-700 space-y-2 leading-relaxed">
          <p className="font-bold text-rose-900">
            🚨 DİKKAT: Ekran kilidini ve hareketsizlik zaman aşımını (Inactivity Timeout) tamamen devre dışı bırakmak üzeresiniz.
          </p>
          <p>
            Bu ayar kapatıldığında, bilgisayarınızın başından ayrıldığınızda veya ekranınızı açık unuttuğunuzda şirketinizin
            tüm şifreli harcamaları, kasa nakit bakiyeleri, ortak alacakları ve cari bilgileri cihazınıza fiziksel erişimi
            olan herkes tarafından serbestçe görüntülenebilir ve değiştirilebilir.
          </p>
          <p className="text-[11px] text-slate-500 italic">
            Bu korumanın kapatılmasından kaynaklanabilecek veri sızıntısı, yetkisiz kayıt silme/değiştirme veya şirket içi
            güvenlik ihlallerinde tüm sorumluluk kullanıcıya aittir.
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
            Bu ayarın doğurabileceği tüm yetkisiz erişim ve veri güvenliği risklerini <strong>anladığımı, kabul ettiğimi</strong> ve sorumluluğu üstlendiğimi beyan ederim.
          </span>
        </label>

        {/* Butonlar */}
        <div className="pt-2 flex justify-end gap-2.5 text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            Vazgeç (Kilidi Açık Tut)
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
            Anladım, Kilidi Kapat
          </button>
        </div>
      </div>
    </div>
  );
};
