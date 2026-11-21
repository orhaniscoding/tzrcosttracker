import { useLocale } from '../context/LocaleContext.js';
import React, { useState, useEffect } from 'react';
import {
  Table,
  PlusCircle,
  Wallet,
  Scale,
  Users,
  BarChart3,
  Calendar,
  CalendarDays,
  FileSpreadsheet,
  FolderTree,
  Tag,
  UserCheck,
  UserPlus,
  KeyRound,
  ShieldCheck,
  ShieldAlert,
  Lock,
  Settings,
  ChevronDown,
  ChevronRight,
  LogOut,
  Building2,
  Receipt,
  CheckCircle2,
  Trash2,
  Landmark,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext.js';
import { canAccessView, isValidRole } from '../view-access.js';

export type NavView =
  // 1. Maliyet & Harcama
  | 'transactions_list'
  | 'transactions_new'
  | 'parties_ledger'
  // 2. Kasa & Finansman
  | 'kasa_list'
  | 'accounts_hub'
  | 'kasa_balance'
  | 'kasa_contributions'
  // 3. Raporlar & Analiz
  | 'reports_charts'
  | 'reports_date_range'
  | 'reports_daily'
  | 'reports_yearly'
  // 4. Kategori & Kalemler
  | 'categories_tree'
  | 'categories_new'
  // 5. Kullanıcılar & Roller
  | 'users_list'
  | 'users_new'
  | 'users_pin'
  // 6. Denetim & Güvenlik
  | 'audit_logs'
  | 'audit_verify'
  | 'backup_vault'
  | 'trash_list'
  | 'security_lock'
  | 'security_2fa'
  // 7. Sistem Ayarları
  | 'settings_branding';

interface NavGroup {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: Array<{
    id: NavView;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: string;
  }>;
}

interface SidebarProps {
  role?: string;
  currentView: NavView;
  onSelectView: (view: NavView) => void;
  auditVerified: boolean | null;
  userName?: string;
  onOpen2FA: () => void;
  onOpenPinSwitch: () => void;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  role,
  currentView,
  onSelectView,
  auditVerified,
  userName,
  onOpen2FA,
  onOpenPinSwitch,
  onLogout,
}) => {
  const { t } = useLocale();
  const { settings } = useTheme();

  const navGroups: NavGroup[] = [
    {
      id: 'expenses',
      title: t("Maliyet & Harcamalar", "Costs and expenses"),
      icon: Receipt,
      items: [
        { id: 'transactions_list', label: t("Harcama Tablosu", "Expense register"), icon: Table, badge: 'Excel' },
        { id: 'transactions_new', label: t("Yeni Harcama Ekle", "Add an expense"), icon: PlusCircle },
        { id: 'parties_ledger', label: t("Cari & Taşeron Karnesi", "Supplier and contractor ledger"), icon: Building2, badge: t("Ekstre", "Statement") },
      ],
    },
    {
      id: 'cash',
      title: t("Kasa & Finansman", "Cash and funding"),
      icon: Wallet,
      items: [
        { id: 'kasa_list', label: t("Kasa & Nakit Girişleri", "Cash and deposits"), icon: Wallet },
        { id: 'accounts_hub', label: t("Likidite & Cüzdanlar Hub'ı", "Cash and bank accounts"), icon: Landmark, badge: 'Hub' },
        { id: 'kasa_balance', label: t("Bilanço & Vade Radarı", "Balances and due dates"), icon: Scale },
        { id: 'kasa_contributions', label: t("Şahıs / Ortak Bilançosu", "Personal and partner balances"), icon: Users, badge: t("Oto-Kasa", "Personal funds") },
      ],
    },
    {
      id: 'reports',
      title: t("Raporlar & Analiz", "Reports and analysis"),
      icon: FileSpreadsheet,
      items: [
        { id: 'reports_charts', label: t("Finansal Grafikler", "Financial charts"), icon: BarChart3 },
        { id: 'reports_date_range', label: t("Tarih Aralıklı Rapor", "Date range report"), icon: Calendar },
        { id: 'reports_daily', label: t("Günlük Kasa Mizanı", "Daily cash report"), icon: CalendarDays },
        { id: 'reports_yearly', label: t("12 Aylık Yıllık Bilanço", "12-month balance report"), icon: FileSpreadsheet },
      ],
    },
    {
      id: 'categories',
      title: t("Kategori & Kalemler", "Categories and items"),
      icon: FolderTree,
      items: [
        { id: 'categories_tree', label: t("Kategori Ağacı & Döküm", "Category breakdown"), icon: FolderTree },
        { id: 'categories_new', label: t("Yeni Kategori Tanımla", "Create a category"), icon: Tag },
      ],
    },
    {
      id: 'users',
      title: t("Kullanıcılar & Yetkiler", "Users and roles"),
      icon: Users,
      items: [
        { id: 'users_list', label: t("Kayıtlı Kullanıcılar", "Users"), icon: UserCheck },
        { id: 'users_new', label: t("Yeni Kullanıcı Tanımla", "Add a user"), icon: UserPlus },
        { id: 'users_pin', label: t("Kişisel Hızlı PIN Ayarı", "Personal PIN"), icon: KeyRound },
      ],
    },
    {
      id: 'security',
      title: t("Denetim & Güvenlik", "Audit and security"),
      icon: ShieldCheck,
      items: [
        { id: 'audit_logs', label: t("İşlem Logları Tablosu", "Audit log"), icon: ShieldCheck },
        { id: 'audit_verify', label: t("Mühür Doğrulama (SHA-256)", "Verify integrity (SHA-256)"), icon: Lock },
        { id: 'backup_vault', label: t("Şifreli Yedek (.tzrvault)", "Encrypted backup (.tzrvault)"), icon: Lock, badge: 'Vault' },
        { id: 'trash_list', label: t("Çöp Kutusu & Geri Alma", "Trash and restore"), icon: Trash2 },
        { id: 'security_lock', label: t("Kilit & Zaman Aşımı", "Screen lock and timeout"), icon: KeyRound },
      ],
    },
    {
      id: 'settings',
      title: t("Sistem Ayarları", "Settings"),
      icon: Settings,
      items: [
        { id: 'settings_branding', label: t("Firma Bilgisi & Logo", "Company details and logo"), icon: Building2 },
      ],
    },
  ];

  // Aktif grubun ID'sini bul
  const getActiveGroupId = (view: NavView): string => {
    for (const group of navGroups) {
      if (group.items.some((item) => item.id === view)) {
        return group.id;
      }
    }
    return 'expenses';
  };

  // Açık gruplar (Başlangıçta aktif grup açık)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {
      expenses: true,
      cash: true,
      reports: true,
      categories: false,
      users: false,
      security: false,
      settings: false,
    };
    initial[getActiveGroupId(currentView)] = true;
    return initial;
  });

  // currentView değiştiğinde ilgili grubu otomatik aç
  useEffect(() => {
    const activeGroupId = getActiveGroupId(currentView);
    setOpenGroups((prev) => ({ ...prev, [activeGroupId]: true }));
  }, [currentView]);

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between shrink-0 h-screen sticky top-0 select-none">
      {/* ÜST BÖLÜM: LOGO & GÜVENLİK MÜHRÜ */}
      <div className="flex flex-col min-h-0">
        {/* Firma Logo & Başlık */}
        <div className="p-4 border-b border-slate-800 flex items-center gap-3">
          {settings.logoUrl ? (
            <img src={settings.logoUrl} alt="Logo" className="h-9 w-9 rounded-lg object-contain bg-slate-800 p-1" />
          ) : (
            <div
              className="h-9 w-9 rounded-lg flex items-center justify-center font-bold text-white shadow-md shrink-0"
              style={{ backgroundColor: settings.primaryColor }}
            >
              <Building2 className="h-5 w-5" />
            </div>
          )}
          <div className="truncate">
            <h1 className="text-sm font-bold text-white truncate">{settings.companyName}</h1>
            <p className="text-[11px] text-slate-400 truncate">{settings.appTitle}</p>
          </div>
        </div>

        {/* Canlı Kriptografik Bütünlük Rozeti */}
        {role === 'admin' && <div className="px-4 py-2.5 border-b border-slate-800/80">
          <div
            className={`flex items-center gap-2 p-2 rounded-lg text-[11px] font-medium border ${
              auditVerified === true
                ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/70'
                : auditVerified === false
                ? 'bg-rose-950/60 text-rose-400 border-rose-800/70'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}
          >
            {auditVerified === true ? (
              <>
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="truncate">{t("Kriptografik Mühür: Kusursuz", "Audit integrity verified")}</span>
              </>
            ) : auditVerified === false ? (
              <>
                <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
                <span className="truncate">{t("UYARI: Kurcalama Tespit Edildi!", "Warning: audit verification failed")}</span>
              </>
            ) : (
               <span>{t("Mühür durumu bilinmiyor", "Audit integrity unknown")}</span>
            )}
          </div>
        </div>}

        {/* AKORDİYON HİYERARŞİK MENÜ LİSTESİ */}
        <nav className="p-2.5 space-y-1.5 overflow-y-auto flex-1 text-xs">
          {navGroups.map((group) => ({ ...group, items: group.items.filter((item) => canAccessView(role, item.id)) })).filter((group) => group.items.length > 0).map((group) => {
            const GroupIcon = group.icon;
            const isOpen = !!openGroups[group.id];
            const hasActiveChild = group.items.some((item) => item.id === currentView);

            return (
              <div key={group.id} className="space-y-0.5">
                {/* Ana Menü Başlığı (Tıklanabilir Klasör) */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg font-semibold transition ${
                    hasActiveChild
                      ? 'text-white bg-slate-800/80'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2 truncate">
                    <GroupIcon className={`h-4 w-4 shrink-0 ${hasActiveChild ? 'text-blue-400' : 'text-slate-400'}`} />
                    <span className="truncate">{group.title}</span>
                  </div>
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-slate-500 shrink-0" />
                  )}
                </button>

                {/* Alt Menü Maddeleri (Açılır Ağaç) */}
                {isOpen && (
                  <div className="pl-3.5 pr-1 py-0.5 space-y-0.5 border-l border-slate-800 ml-3">
                    {group.items.map((subItem) => {
                      const SubIcon = subItem.icon;
                      const isActive = currentView === subItem.id;

                      return (
                        <button
                          key={subItem.id}
                          type="button"
                          onClick={() => { if (canAccessView(role, subItem.id)) onSelectView(subItem.id); }}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[11px] font-medium transition ${
                            isActive
                              ? 'bg-blue-600 text-white shadow-sm font-semibold'
                              : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/60'
                          }`}
                          style={isActive ? { backgroundColor: settings.primaryColor } : {}}
                        >
                          <div className="flex items-center gap-2 truncate">
                            <SubIcon className="h-3.5 w-3.5 shrink-0 opacity-80" />
                            <span className="truncate">{subItem.label}</span>
                          </div>

                          {subItem.badge && (
                            <span
                              className={`text-[9px] px-1.5 py-0.2 rounded font-semibold ${
                                isActive
                                  ? 'bg-white/20 text-white'
                                  : 'bg-slate-800 text-slate-400 border border-slate-700'
                              }`}
                            >
                              {subItem.badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* ALT BÖLÜM: HIZLI PIN, 2FA & ÇIKIŞ */}
      <div className="p-3 border-t border-slate-800 space-y-1.5 shrink-0">
        <button
          disabled={!isValidRole(role)}
          onClick={() => { if (isValidRole(role)) onOpenPinSwitch(); }}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold text-amber-300 bg-amber-950/40 border border-amber-800/60 hover:bg-amber-900/50 transition"
          title={t("Şantiyede 4 haneli PIN ile başka kullanıcıya geç", "Switch accounts using a four-digit PIN")}
        >
          <div className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 text-amber-400" />
            <span>{t("Kullanıcı Değiştir", "Switch user")}</span>
          </div>
          <span className="text-[10px] bg-amber-400/20 px-1.5 py-0.2 rounded font-mono">PIN</span>
        </button>

        <button
          disabled={!canAccessView(role, 'security_2fa')}
          onClick={() => { if (canAccessView(role, 'security_2fa')) onOpen2FA(); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 hover:bg-slate-800 transition"
        >
          <Lock className="h-3.5 w-3.5 text-blue-400" />
          <span>{t("2FA Güvenlik Ayarları", "Two-factor authentication")}</span>
        </button>

        {userName && (
          <div className="pt-2 border-t border-slate-800 flex items-center justify-between px-2 text-xs">
            <span className="text-slate-400 truncate max-w-[120px] font-medium">{userName}</span>
            <button
              onClick={onLogout}
              className="text-rose-400 hover:text-rose-300 text-[11px] font-semibold flex items-center gap-1"
              title={t("Çıkış Yap", "Sign out")}
            >
              <LogOut className="h-3.5 w-3.5" />
              <span>{t("Çıkış", "Sign out")}</span>
            </button>
          </div>
        )}
      </div>
    </aside>
  );
};
