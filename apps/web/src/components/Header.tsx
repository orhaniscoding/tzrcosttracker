import { useLocale } from '../context/LocaleContext.js';
import React from 'react';
import { ShieldCheck, ShieldAlert, Settings, Lock, LogOut, Building2 } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.js';

interface HeaderProps {
  onOpenSettings: () => void;
  onOpen2FA: () => void;
  onLogout: () => void;
  auditVerified: boolean | null;
  userName?: string;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenSettings,
  onOpen2FA,
  onLogout,
  auditVerified,
  userName,
}) => {
  const { t: copy } = useLocale();
  const { settings } = useTheme();

  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md px-6 py-3.5 sticky top-0 z-40 flex items-center justify-between">
      {/* Sol: Logo ve Şirket Ünvanı */}
      <div className="flex items-center gap-3">
        {settings.logoUrl ? (
          <img src={settings.logoUrl} alt="Logo" className="h-9 w-9 rounded-lg object-contain bg-slate-800 p-1" />
        ) : (
          <div
            className="h-9 w-9 rounded-lg flex items-center justify-center font-bold text-white shadow-md"
            style={{ backgroundColor: settings.primaryColor }}
          >
            <Building2 className="h-5 w-5" />
          </div>
        )}
        <div>
          <h1 className="text-base font-bold text-slate-100 flex items-center gap-2">
            {settings.companyName}
            <span className="text-xs font-normal text-slate-400 px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700">
              {settings.appTitle}
            </span>
          </h1>
        </div>
      </div>

      {/* Sağ: Güvenlik Rozeti, Kullanıcı ve Eylemler */}
      <div className="flex items-center gap-3">
        {/* Değiştirilemez Kriptografik Denetim Rozeti */}
        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border ${
            auditVerified === true
              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/80'
              : auditVerified === false
              ? 'bg-rose-950/60 text-rose-400 border-rose-800/80'
              : 'bg-slate-800 text-slate-400 border-slate-700'
          }`}
          title={copy("Tüm finansal veritabanı kayıtları kriptografik SHA-256 zinciriyle mühürlüdür.", "The recorded audit chain is checked with SHA-256.")}
        >
          {auditVerified === true ? (
            <>
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span>{copy("Kriptografik Bütünlük: Mühürlü", "Audit integrity verified")}</span>
            </>
          ) : auditVerified === false ? (
            <>
              <ShieldAlert className="h-4 w-4 text-rose-400" />
              <span>{copy("UYARI: Veri Kurcalanmış!", "Warning: audit verification failed")}</span>
            </>
          ) : (
            <span>{copy("Denetim Bekleniyor...", "Audit verification pending…")}</span>
          )}
        </div>

        {/* 2FA Butonu */}
        <button
          onClick={onOpen2FA}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          title={copy("Google / Microsoft Authenticator 2FA Ayarları", "Two-factor authentication settings")}
        >
          <Lock className="h-3.5 w-3.5 text-blue-400" />
          <span>{copy("2FA Güvenlik", "Two-factor authentication")}</span>
        </button>

        {/* Kozmetik & Şirket Ayarları */}
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition"
          title={copy("Kişiselleştirme & Şirket Ayarları", "Branding and company settings")}
        >
          <Settings className="h-4 w-4" />
        </button>

        {/* Çıkış Yap */}
        {userName && (
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-900/50 transition"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>{copy("Çıkış (", "Sign out (")}{userName})</span>
          </button>
        )}
      </div>
    </header>
  );
};
