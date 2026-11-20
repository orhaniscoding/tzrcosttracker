import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Sidebar, NavView } from './components/Sidebar.js';
import { BalanceBar } from './components/BalanceBar.js';
import { CompanyDebtTable } from './components/CompanyDebtTable.js';
import { ProjectSelector } from './components/ProjectSelector.js';
import { FinancialCharts } from './components/FinancialCharts.js';
import { QuickTransactionTable } from './components/QuickTransactionTable.js';
import { NewTransactionView } from './components/NewTransactionView.js';
import { NewTransactionModal } from './components/NewTransactionModal.js';
import { EditTransactionModal } from './components/EditTransactionModal.js';
import { KasaTable } from './components/KasaTable.js';
import { AddKasaModal } from './components/AddKasaModal.js';
import { CategoriesView } from './components/CategoriesView.js';
import { PersonContributionsView } from './components/PersonContributionsView.js';
import { ReportsCenterView } from './components/ReportsCenterView.js';
import { AuditLogsView } from './components/AuditLogsView.js';
import { AuditView } from './components/AuditView.js';
import { UserManagementView } from './components/UserManagementView.js';
import { PinSwitchModal } from './components/PinSwitchModal.js';
import { PartiesView } from './components/PartiesView.js';
import { TrashView } from './components/TrashView.js';
import { WhiteLabelModal } from './components/WhiteLabelModal.js';
import { TwoFactorModal } from './components/TwoFactorModal.js';
import { OnboardingWizard } from './components/OnboardingWizard.js';
import { ScreenLockModal } from './components/ScreenLockModal.js';
import { UniversalExcelModal } from './components/UniversalExcelModal.js';
import { SecuritySettingsView } from './components/SecuritySettingsView.js';
import { BackupCenterView } from './components/BackupCenterView.js';
import { LiquidityHubView } from './components/LiquidityHubView.js';
import { ApiClient } from './api/client.js';
import { ProjectScopeController, canRenderScopedView } from './project-scope.js';
import { canAccessView, canCreateProject, canMutateTransactions, canManageCategories, isValidRole } from './view-access.js';
import type { Transaction } from '@cost-core/types';
import {
  Download,
  LogIn,
  Lock,
  UploadCloud,
  CheckCircle,
} from 'lucide-react';

export const App: React.FC = () => {
  const [user, setUser] = useState<any>(null);
  const [scopeController] = useState(() => new ProjectScopeController());
  const scope = useSyncExternalStore(scopeController.subscribe, scopeController.getSnapshot, scopeController.getSnapshot);
  const { projects, selectedProjectId, transactions, categories, balance, auditVerified, loading: isLoading } = scope;
  useEffect(() => scopeController.connect(), [scopeController]);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // Sol Menüden Seçilen Aktif Görünüm (Varsayılan: Harcama Listesi)
  const [currentView, setCurrentView] = useState<NavView>('transactions_list');

  // Modals State
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [isAddKasaOpen, setIsAddKasaOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [is2FAModalOpen, setIs2FAModalOpen] = useState(false);
  const [isPinSwitchOpen, setIsPinSwitchOpen] = useState(false);
  const [isUniversalExcelOpen, setIsUniversalExcelOpen] = useState(false);

  // İlk Kurulum (Onboarding) State
  const [showOnboarding, setShowOnboarding] = useState(false);

  // Güvenlik & Hareketsizlik Zaman Aşımı (Inactivity Timeout) State
  const [inactivityTimeout, setInactivityTimeout] = useState<number>(() => {
    const saved = localStorage.getItem('tzrcoster_timeout');
    return saved !== null ? parseInt(saved, 10) : 300; // Varsayılan: 5 dakika (300 sn)
  });
  const [lockOnRefresh, setLockOnRefresh] = useState<boolean>(() => {
    const saved = localStorage.getItem('tzrcoster_refresh_lock');
    return saved !== null ? saved === 'true' : true; // Varsayılan: sayfa yenilenince PIN kilidi açık
  });
  const [isScreenLocked, setIsScreenLocked] = useState<boolean>(() => {
    const token = ApiClient.getToken();
    const lockPref = localStorage.getItem('tzrcoster_refresh_lock') !== 'false';
    return !!token && lockPref;
  });

  // Login Modal State
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [require2FA, setRequire2FA] = useState(false);
  const [authError, setAuthError] = useState('');
  const sessionGenRef = useRef(0);
  const authRequestRef = useRef(0);
  const isSessionCurrent = (gen: number, originToken: string | null) => gen === sessionGenRef.current && ApiClient.getToken() === originToken;
  const userRef = useRef(user);
  userRef.current = user;
  const lockedRef = useRef(isScreenLocked);
  lockedRef.current = isScreenLocked;
  const closePrivateModals = () => {
    setEditingTransaction(null); setIsNewModalOpen(false); setIsAddKasaOpen(false);
    setIsSettingsModalOpen(false); setIs2FAModalOpen(false); setIsPinSwitchOpen(false); setIsUniversalExcelOpen(false);
  };
  useEffect(() => { setEditingTransaction(null); setIsNewModalOpen(false); setIsAddKasaOpen(false); setIsUniversalExcelOpen(false); }, [scope.scopeKey]);
  useEffect(() => {
    if (!scope.ready) { setEditingTransaction(null); setIsNewModalOpen(false); setIsAddKasaOpen(false); setIsUniversalExcelOpen(false); }
  }, [scope.ready]);
  const acceptActor = (actor: any, locked = false) => {
    if (userRef.current?.id !== actor?.id || userRef.current?.role !== actor?.role) {
      sessionGenRef.current++; closePrivateModals(); setCurrentView('transactions_list');
    }
    userRef.current = actor;
    scopeController.setActor(actor, locked);
    setUser(actor);
    setShowLoginModal(false);
  };
  useEffect(() => ApiClient.subscribeAuthChange(() => {
    sessionGenRef.current++; scopeController.invalidate();
    // PIN unlock rotates the token before onUnlocked. Preserve only the locked
    // identity shell, never the protected financial subtree.
    if (lockedRef.current && userRef.current && ApiClient.getToken()) return;
    userRef.current = null; setUser(null); closePrivateModals(); setShowLoginModal(true);
    const token = ApiClient.getToken(), generation = ApiClient.getAuthGeneration(), gen = sessionGenRef.current;
    if (token) void ApiClient.getMe().then((actor) => {
      if (!isSessionCurrent(gen, token) || generation !== ApiClient.getAuthGeneration()) return;
      acceptActor(actor, lockedRef.current);
      if (!lockedRef.current) void scopeController.reload();
    }).catch(() => { /* Remain signed out locally; no private state survives. */ });
  }), [scopeController]);
  useEffect(() => () => { sessionGenRef.current++; authRequestRef.current++; userRef.current = null; }, []);
  const navigate = (view: NavView) => {
    if (!canAccessView(userRef.current?.role, view)) return;
    if (view === 'settings_branding') setIsSettingsModalOpen(true);
    else if (view === 'security_2fa') setIs2FAModalOpen(true);
    else setCurrentView(view);
  };

  // 1. Hareketsizlik Zaman Aşımı Takipçisi (Inactivity Listener)
  const handleLockNow = () => {
    // Zero-Memory Exposure: Hassas verileri anında bellekten sil
    sessionGenRef.current++;
    scopeController.lock();
    closePrivateModals();
    lockedRef.current = true;
    setIsScreenLocked(true);
  };

  useEffect(() => {
    if (!user || inactivityTimeout <= 0 || isScreenLocked) return;

    let timer: NodeJS.Timeout;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        handleLockNow();
      }, inactivityTimeout * 1000);
    };

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((ev) => window.addEventListener(ev, resetTimer, { passive: true }));
    resetTimer();

    return () => {
      clearTimeout(timer);
      events.forEach((ev) => window.removeEventListener(ev, resetTimer));
    };
  }, [user, inactivityTimeout, isScreenLocked]);

  const loadData = scopeController.reload;

  const checkAuth = async () => {
    const request = ++authRequestRef.current;
    const gen = sessionGenRef.current;
    const originToken = ApiClient.getToken();
    const authGeneration = ApiClient.getAuthGeneration();
    const stale = () => request !== authRequestRef.current || !isSessionCurrent(gen, originToken) || authGeneration !== ApiClient.getAuthGeneration();
    scopeController.lock();
    userRef.current = null; setUser(null); closePrivateModals();
    try {
      // Önce ilk kurulum gerekip gerekmediğini kontrol et
      const sysStatus = await ApiClient.getSystemStatus().catch(() => null);
      if (stale()) return;
      if (sysStatus && sysStatus.needsSetup) {
        setShowOnboarding(true);
        return;
      }

      const me = await ApiClient.getMe();
      if (stale()) return;
      acceptActor(me, lockOnRefresh);
      setShowLoginModal(false);

      if (lockOnRefresh) {
        // Zero-DOM Exposure: Kilit açılana kadar verileri çekme ve ekranı kilitli tut!
        setIsScreenLocked(true);
      } else {
        setIsScreenLocked(false);
        loadData();
      }
    } catch {
      if (stale()) return;
      scopeController.invalidate(); userRef.current = null; setUser(null); closePrivateModals();
      setShowLoginModal(true);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const handleSelectProject = (id: string | null) => {
    closePrivateModals();
    void scopeController.selectProject(id);
  };

  const handleCreateProject = async (name: string, budget = 0) => {
    if (!canCreateProject(userRef.current?.role) || !scopeController.getSnapshot().ready) return;
    const current = scopeController.captureSession();
    const created = await ApiClient.createProject({ name, budget, currency: 'TRY' });
    if (!current() || !canCreateProject(userRef.current?.role)) return;
    handleSelectProject(created.id);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const request = ++authRequestRef.current;
    const gen = sessionGenRef.current;
    const originToken = ApiClient.getToken();
    const authGeneration = ApiClient.getAuthGeneration();
    const stale = () => request !== authRequestRef.current || gen !== sessionGenRef.current || ApiClient.getToken() !== originToken || ApiClient.getAuthGeneration() !== authGeneration;
    try {
      setAuthError('');
      const res = await ApiClient.login({
        usernameOrEmail: username,
        password,
        twoFactorCode: twoFactorCode || undefined,
      });

      if (stale()) return;
      if (res.requireTwoFactor) {
        setRequire2FA(true);
        return;
      }
      if (stale()) return;
      sessionGenRef.current += 1;

      ApiClient.setToken(res.token);
      acceptActor(res.user);
      setShowLoginModal(false);
      setIsScreenLocked(false);
      setPassword('');
      setTwoFactorCode('');
      loadData();
    } catch (err: any) {
      if (stale()) return;
      setAuthError(err.message || 'Giriş yapılamadı.');
    }
  };

  const resetLocalSession = () => {
    sessionGenRef.current += 1;
    scopeController.invalidate();
    ApiClient.setToken(null);
    userRef.current = null;
    setUser(null);
    setImportNotice(null);
    setEditingTransaction(null);
    setIsNewModalOpen(false);
    setIsAddKasaOpen(false);
    setIsSettingsModalOpen(false);
    setIs2FAModalOpen(false);
    setIsPinSwitchOpen(false);
    setIsUniversalExcelOpen(false);
    setPassword('');
    setTwoFactorCode('');
    setRequire2FA(false);
    setAuthError('');
    setIsScreenLocked(false);
    setShowLoginModal(true);
  };
  const handleLogoutToLogin = () => {
    const request = ApiClient.getToken() ? ApiClient.logout() : Promise.resolve(null);
    resetLocalSession();
    const gen = sessionGenRef.current;
    Promise.resolve(request).then((res: any) => { if (res && res.ok === false) throw new Error('logout'); }).catch(() => { if (sessionGenRef.current === gen && !ApiClient.getToken()) setAuthError('Cikis sunucuda tamamlanamadi.'); });
  };
  const handleLogout = handleLogoutToLogin;
  const handleSessionExpired = () => { resetLocalSession(); setAuthError('Oturumunuz sona erdi. Lutfen tekrar giris yapin.'); };
  useEffect(() => ApiClient.subscribeSessionInvalid(handleSessionExpired), []);

  const handleAddTransaction = async (txData: any) => {
    if (!canAccessView(userRef.current?.role, 'transactions_new') || !scopeController.getSnapshot().ready) return;
    const current = scopeController.captureSession();
    await ApiClient.createTransaction({
      ...txData,
      projectId: scopeController.getSnapshot().selectedProjectId || undefined,
    });
    if (!current()) return;
    await loadData();
  };

  const handleUpdateTransaction = async (id: string, updates: any) => {
    if (!canAccessView(userRef.current?.role, 'transactions_new') || !scopeController.getSnapshot().ready) return;
    const current = scopeController.captureSession();
    await ApiClient.updateTransaction(id, updates);
    if (!current()) return;
    await loadData();
  };

  const handleDeleteTransaction = async (id: string) => {
    if (!canAccessView(userRef.current?.role, 'transactions_new') || !scopeController.getSnapshot().ready) return;
    const current = scopeController.captureSession();
    await ApiClient.deleteTransaction(id);
    if (!current()) return;
    await loadData();
  };

  const handleMarkPaid = async (id: string) => {
    if (!canAccessView(userRef.current?.role, 'transactions_new') || !scopeController.getSnapshot().ready) return;
    const current = scopeController.captureSession();
    await ApiClient.markTransactionPaid(id);
    if (!current()) return;
    await loadData();
  };

  const handleSearch = scopeController.search;

  const handleAddCategory = async (catData: any) => {
    if (!canAccessView(userRef.current?.role, 'categories_new') || !scopeController.getSnapshot().ready) return;
    const current = scopeController.captureSession();
    await ApiClient.createCategory(catData);
    if (!current()) return;
    await loadData();
  };

  const handleDeleteCategory = async (id: string) => {
    if (!canAccessView(userRef.current?.role, 'categories_new') || !scopeController.getSnapshot().ready) return;
    if (!confirm('Bu kategoriyi silmek istediğinizden emin misiniz?')) return;
    const current = scopeController.captureSession();
    await ApiClient.deleteCategory(id);
    if (!current()) return;
    await loadData();
  };

  // CSV Dışa Aktarma
  const handleExportCSV = () => {
    if (!scopeController.getSnapshot().ready) return;
    if (transactions.length === 0) {
      alert('Dışa aktarılacak hareket bulunmuyor.');
      return;
    }

    const headers = ['Tarih', 'Başlık', 'Tutar', 'Tutar Okunuşu', 'Para Birimi', 'Kategori', 'Ödeme Kaynağı', 'Tedarikçi/Cari', 'Durum', 'Açıklama'];
    const rows = transactions.map((t) => {
      const cat = categories.find((c) => c.id === t.categoryId)?.name || '';
      return [
        t.date.split('T')[0],
        `"${t.title.replace(/"/g, '""')}"`,
        t.amount,
        `"${t.amountInWords || ''}"`,
        t.currency,
        `"${cat}"`,
        `"${t.paymentSource === 'person_out_of_pocket' ? (t.payerPersonName || 'Şahıs') : 'Şirket Kasası'}"`,
        `"${(t.party || '').replace(/"/g, '""')}"`,
        `"${t.isPaid ? 'Ödendi' : 'Vadeli'}"`,
        `"${(t.description || '').replace(/"/g, '""')}"`,
      ].join(';');
    });

    const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(';'), ...rows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `TZRCoster_Maliyet_Raporu_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ZERO-DOM-EXPOSURE: Ekran kilitliyken arkada HİÇBİR veri, tablo, başlık veya DOM elemanı render edilmez!
  // DevTools veya AdBlocker ile kilit ekranı silinse dahi arkada bomboş beyaz sayfa kalır.
  if (isScreenLocked && user && !showOnboarding && !showLoginModal) {
    return (
      <ScreenLockModal
        isOpen={true}
        user={user}
        onUnlocked={async () => {
          const gen = sessionGenRef.current, token = ApiClient.getToken(), generation = ApiClient.getAuthGeneration();
          try {
            const actor = await ApiClient.getMe();
            if (!isSessionCurrent(gen, token) || generation !== ApiClient.getAuthGeneration()) return;
            acceptActor(actor);
            setIsScreenLocked(false);
            await loadData();
          } catch { if (isSessionCurrent(gen, token)) handleSessionExpired(); }
        }}
        onSwitchUser={handleLogoutToLogin}
        onPasswordLogin={handleLogoutToLogin}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="min-h-screen flex bg-slate-100 text-slate-900 font-sans antialiased">
      {/* Authenticated subtree: unmounts all protected UI, private child state and child fetches when no user is present */}
      {user && (
        <>
      {/* SOL YANDAN MENÜ (SIDEBAR) */}
      <Sidebar
        role={user.role}
        currentView={currentView}
        onSelectView={navigate}
        auditVerified={auditVerified}
        userName={user?.fullName || user?.username}
        onOpen2FA={() => navigate('security_2fa')}
        onOpenPinSwitch={() => { if (isValidRole(userRef.current?.role)) setIsPinSwitchOpen(true); }}
        onLogout={handleLogout}
      />

      {/* SAĞ ANA İÇERİK ALANI */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-y-auto">
        {/* ÜST EYLEM ÇUBUĞU (TOP NAVBAR) */}
        <header className="bg-white border-b border-slate-200 px-6 py-3.5 sticky top-0 z-30 flex flex-wrap items-center justify-between gap-4 shadow-sm">
          {/* Sol: Proje Seçici */}
          <div className="flex items-center gap-3">
            <ProjectSelector
              key={`${user.id}:${user.role}:${scope.scopeKey}`}
              canCreate={canCreateProject(user.role)}
              disabled={!scope.ready}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onSelectProject={handleSelectProject}
              onCreateProject={handleCreateProject}
            />
          </div>

          {/* Sağ: İçe Aktarma, Ekran Kilidi ve Export Aksiyonları */}
          <div className="flex items-center gap-2.5">
            {canCreateProject(user.role) && <button
              disabled={!scope.ready}
              onClick={() => { if (canCreateProject(userRef.current?.role) && scopeController.getSnapshot().ready) setIsUniversalExcelOpen(true); }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition"
              title="Herhangi bir Excel dosyasını (.xlsx) veya Google E-Tablo linkini akıllı sütun eşleme ile içeri aktarır"
            >
              <UploadCloud className="h-4 w-4" />
              <span>📥 Akıllı Excel & E-Tablo Aktar</span>
            </button>}

            <button
              onClick={handleLockNow}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 shadow-sm transition"
              title="Ekranı Anında Kilitle"
            >
              <Lock className="h-4 w-4 text-amber-600" />
              <span>Kilitle</span>
            </button>

            <button
              onClick={handleExportCSV}
              disabled={!scope.ready}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-sm transition"
              title="Excel uyumlu CSV Raporu indir"
            >
              <Download className="h-4 w-4 text-emerald-600" />
              <span>Excel / CSV</span>
            </button>
          </div>
        </header>

        {/* İçe Aktarma Başarı Bildirimi */}
        {importNotice && (
          <div className="bg-emerald-50 border-b border-emerald-200 text-emerald-800 px-6 py-2.5 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle className="h-4 w-4 text-emerald-600" />
              <span>{importNotice}</span>
            </div>
            <button onClick={() => setImportNotice(null)} className="text-emerald-700 font-bold hover:underline">
              Kapat
            </button>
          </div>
        )}

        {/* İÇERİK GÖVDE ALANI - HER ALTMENÜ İÇİN ÖZEL BAĞIMSIZ EKRAN */}
        <main className="flex-1 p-6 space-y-6 max-w-7xl w-full">
          {scope.error && <div role="alert" className="p-4 bg-rose-50 text-rose-800">{scope.error} <button onClick={() => void loadData()}>Yeniden dene</button></div>}
          {scope.loading && <p role="status">Güncel proje kapsamı yükleniyor…</p>}
          {scope.noProjects && <p role="status">Atanmış projeniz bulunmuyor. Proje erişimi için yöneticinizle görüşün. Kişisel PIN ve güvenlik ayarlarınızı kullanabilirsiniz. <button onClick={() => void loadData()}>Erişimi yeniden kontrol et</button></p>}
          {!isValidRole(user.role) && <p role="alert">Bu kullanıcı rolü için erişim tanımlı değil.</p>}
          <React.Fragment key={`${user.id}:${user.role}:${scope.scopeKey}`}>
          {canRenderScopedView(user.role, currentView, scope) && <>
          {/* 4'lü Canlı Bilanço Barı (Harcama ve Bilanço görünümlerinde her zaman görünür) */}
          {(currentView === 'transactions_list' || currentView === 'kasa_balance') && (
            <BalanceBar
              balance={balance}
              onOpenPersonContributions={() => navigate('kasa_contributions')}
            />
          )}

          {/* 1.1 HARCAMA TABLOSU (EXCEL MODU) */}
          {currentView === 'transactions_list' && (
            <QuickTransactionTable
              canMutate={canMutateTransactions(user.role)}
              transactions={transactions}
              categories={categories}
              onOpenNewModal={() => navigate('transactions_new')}
              onEditTransaction={(tx) => { if (canAccessView(userRef.current?.role, 'transactions_new')) setEditingTransaction(tx); }}
              onDeleteTransaction={handleDeleteTransaction}
              onMarkPaid={handleMarkPaid}
              onSearch={handleSearch}
              isLoading={isLoading}
              selectedProjectId={selectedProjectId}
            />
          )}

          {/* 1.2 YENİ HARCAMA GİRİŞİ (ÖZEL TAM EKRAN) */}
          {currentView === 'transactions_new' && (
            <NewTransactionView
              canMutate={canMutateTransactions(user.role)}
              categories={categories}
              onAddTransaction={handleAddTransaction}
              onNavigateBack={() => navigate('transactions_list')}
              selectedProjectId={selectedProjectId}
            />
          )}

          {/* 1.3 CARİ & TAŞERON KARNESİ (ÖZEL HESAP EKSTRELERİ) */}
          {currentView === 'parties_ledger' && (
            <PartiesView
              transactions={transactions}
              categories={categories}
            />
          )}

          {/* 2.1 KASA & NAKİT GİRİŞLERİ TABLOSU */}
          {currentView === 'kasa_list' && (
            <KasaTable
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
              canMutate={canMutateTransactions(user.role)}
              transactions={transactions}
              onAddKasaEntry={() => { if (canAccessView(userRef.current?.role, 'transactions_new')) setIsAddKasaOpen(true); }}
            />
          )}

          {/* 2.1.1 LİKİDİTE & CÜZDANLAR HUB'I */}
          {currentView === 'accounts_hub' && (
            <LiquidityHubView
              role={user.role}
              projects={projects}
              selectedProjectId={selectedProjectId}
              onDataChanged={loadData}
            />
          )}

          {/* 2.2 BİLANÇO & VADE RADARI GÖRÜNÜMÜ */}
          {currentView === 'kasa_balance' && (
            <div className="space-y-6">
              <CompanyDebtTable transactions={transactions} isLoading={isLoading} canMutate={canMutateTransactions(user.role)} onMarkPaid={handleMarkPaid} />
            </div>
          )}

          {/* 2.3 ŞAHIS / ORTAK BİLANÇOSU */}
          {currentView === 'kasa_contributions' && (
            <PersonContributionsView
              transactions={transactions}
              report={balance}
              isLoading={isLoading}
            />
          )}

          {/* 3.1 FİNANSAL GRAFİKLER & ANALİTİK */}
          {currentView === 'reports_charts' && (
            <FinancialCharts
              transactions={transactions}
              categories={categories}
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
            />
          )}

          {/* 3.2 TARİH ARALIKLI RAPOR (ÖZEL EKRAN) */}
          {currentView === 'reports_date_range' && (
            <ReportsCenterView
              transactions={transactions}
              categories={categories}
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
              subView="date_range"
            />
          )}

          {/* 3.3 GÜNLÜK KASA MİZANI (ÖZEL EKRAN) */}
          {currentView === 'reports_daily' && (
            <ReportsCenterView
              transactions={transactions}
              categories={categories}
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
              subView="daily"
            />
          )}

          {/* 3.4 12 AYLIK YILLIK KONSOLİDE BİLANÇO (ÖZEL EKRAN) */}
          {currentView === 'reports_yearly' && (
            <ReportsCenterView
              transactions={transactions}
              categories={categories}
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
              subView="monthly_yearly"
            />
          )}

          {/* 4.1 KATEGORİ AĞACI & DÖKÜM (ÖZEL EKRAN) */}
          {currentView === 'categories_tree' && (
            <CategoriesView
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
              canManage={canManageCategories(user.role)}
              categories={categories}
              transactions={transactions}
              onAddCategory={handleAddCategory}
              onDeleteCategory={handleDeleteCategory}
              subView="tree"
              onNavigateToTree={() => navigate('categories_new')}
            />
          )}

          {/* 4.2 YENİ KATEGORİ TANIMLA (ÖZEL EKRAN) */}
          {currentView === 'categories_new' && (
            <CategoriesView
              baseCurrency={balance?.baseCurrency}
              isLoading={isLoading}
              canManage={canManageCategories(user.role)}
              categories={categories}
              transactions={transactions}
              onAddCategory={handleAddCategory}
              onDeleteCategory={handleDeleteCategory}
              subView="new"
              onNavigateToTree={() => navigate('categories_tree')}
            />
          )}

          {/* 5.1 KAYITLI KULLANICILAR LİSTESİ */}
          {currentView === 'users_list' && (
            <UserManagementView
              currentUser={user}
              onRefreshAuth={checkAuth}
              subView="list"
              onNavigateToList={() => navigate('users_new')}
            />
          )}

          {/* 5.2 YENİ KULLANICI TANIMLA */}
          {currentView === 'users_new' && (
            <UserManagementView
              currentUser={user}
              onRefreshAuth={checkAuth}
              subView="new"
              onNavigateToList={() => navigate('users_list')}
            />
          )}

          {/* 5.3 KİŞİSEL PIN AYARI */}
          {currentView === 'users_pin' && (
            <UserManagementView
              currentUser={user}
              onRefreshAuth={checkAuth}
              subView="pin"
            />
          )}

          {/* 6.1 İŞLEM LOGLARI TABLOSU (AUDIT TRAIL) */}
          {currentView === 'audit_logs' && (
            <AuditLogsView
              auditVerified={auditVerified}
              onRefreshAudit={scopeController.refreshAudit}
            />
          )}

          {/* 6.2 SHA-256 MÜHÜR DOĞRULAMA (TAMPER CHECK) */}
          {currentView === 'audit_verify' && (
            <AuditView
              auditVerified={auditVerified}
              onRefreshAudit={scopeController.refreshAudit}
            />
          )}

          {/* 6.3 ŞİFRELİ SİSTEM YEDEĞİ (.tzrvault) */}
          {currentView === 'backup_vault' && (
            <BackupCenterView
              onRestored={loadData}
            />
          )}

          {/* 6.4 ÇÖP KUTUSU & GERİ ALMA (SOFT-DELETE) */}
          {currentView === 'trash_list' && (
            <TrashView
              role={user.role}
              selectedProjectId={selectedProjectId}
              categories={categories}
              onRestored={loadData}
            />
          )}

          {/* 6.5 KİLİT & HAREKETSİZLİK ZAMAN AŞIMI POLİTİKASI */}
          {currentView === 'security_lock' && (
            <SecuritySettingsView
              timeoutSeconds={inactivityTimeout}
              onUpdateTimeout={(sec) => {
                setInactivityTimeout(sec);
                localStorage.setItem('tzrcoster_timeout', String(sec));
              }}
              lockOnRefresh={lockOnRefresh}
              onUpdateLockOnRefresh={(val) => {
                setLockOnRefresh(val);
                localStorage.setItem('tzrcoster_refresh_lock', String(val));
              }}
              onLockNow={handleLockNow}
            />
          )}
          </>}
          </React.Fragment>
        </main>
      </div>

      {/* MODALLER */}
      {/* 1. Yeni Harcama Ekleme Penceresi (Hızlı Ekleme) */}
      {scope.ready && canAccessView(user.role, 'transactions_new') && <React.Fragment key={`modals:${scope.scopeKey}`}><NewTransactionModal
        canMutate={canMutateTransactions(user.role)}
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        categories={categories}
        onAddTransaction={handleAddTransaction}
        selectedProjectId={selectedProjectId}
      />

      {/* 2. Kayıt Düzenleme Modalı */}
      <EditTransactionModal
        canMutate={canMutateTransactions(user.role)}
        isOpen={!!editingTransaction}
        onClose={() => setEditingTransaction(null)}
        transaction={editingTransaction}
        categories={categories}
        onSave={handleUpdateTransaction}
        onDelete={handleDeleteTransaction}
      />

      {/* 3. Kasaya Nakit Girişi Ekleme Modalı */}
      <AddKasaModal
        isOpen={isAddKasaOpen}
        onClose={() => setIsAddKasaOpen(false)}
        onAdd={handleAddTransaction}
        categories={categories}
        baseCurrency={balance?.baseCurrency}
      />
      </React.Fragment>}

      {/* 4. Hızlı Kullanıcı Değiştir (PIN Girişi) Modalı */}
      {isValidRole(user.role) && <PinSwitchModal
        isOpen={isPinSwitchOpen}
        onClose={() => setIsPinSwitchOpen(false)}
         onSuccess={async (newUser) => {
          acceptActor(newUser);
          await loadData();
        }}
        currentUserId={user?.id}
        onPasswordLogin={handleLogoutToLogin}
      />}

      {/* 5. Firma & Kozmetik Ayarlar Modalı */}
      {canAccessView(user.role, 'settings_branding') && <WhiteLabelModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />}

      {/* 6. 2FA Güvenlik Modalı */}
      {canAccessView(user.role, 'security_2fa') && <TwoFactorModal
        isOpen={is2FAModalOpen}
        onClose={() => setIs2FAModalOpen(false)}
        onSuccess={() => checkAuth()}
      />}

      {/* 7. Akıllı Evrensel Excel & Google E-Tablolar Aktarım Modalı */}
      {scope.ready && canCreateProject(user.role) && <UniversalExcelModal
        key={`import:${scope.scopeKey}`}
        isOpen={isUniversalExcelOpen}
        onClose={() => setIsUniversalExcelOpen(false)}
        onImportComplete={loadData}
        selectedProjectId={selectedProjectId}
      />}
        </>
      )}

      {/* 8. İlk Kurulum Sihirbazı (Onboarding Wizard) */}
      {showOnboarding && (
        <OnboardingWizard
          onCompleted={async (newUser, token) => {
            sessionGenRef.current += 1;
            ApiClient.setToken(token);
            acceptActor(newUser);
            setIsScreenLocked(false);
            setShowOnboarding(false);
            setShowLoginModal(false);
            await loadData();
          }}
        />
      )}

      {/* GİRİŞ (LOGIN) MODALI */}
      {showLoginModal && !showOnboarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
            <div className="text-center mb-6">
              <div className="h-12 w-12 mx-auto rounded-xl bg-blue-600 flex items-center justify-center text-white font-bold mb-3 shadow-md">
                <Lock className="h-6 w-6" />
              </div>
              <h2 className="text-lg font-bold text-slate-900">TZRCoster Giriş</h2>
              <p className="text-xs text-slate-500 mt-1">Hassas mali alanları şifrelenen mali takip portalı</p>
            </div>

            {authError && (
              <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
                {authError}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-700 font-medium mb-1">Kullanıcı Adı veya E-posta</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:border-blue-600 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1">Parola</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:border-blue-600 focus:outline-none"
                  required
                />
              </div>

              {require2FA && (
                <div>
                  <label className="block text-emerald-700 font-semibold mb-1">
                    Authenticator (6 hane) veya tek kullanımlık yedek kod (XXXX-XXXX) *
                  </label>
                  <input
                    type="text"
                    maxLength={9}
                    placeholder="000000 veya A1B2-C3D4"
                    value={twoFactorCode}
                    onChange={(e) => setTwoFactorCode(e.target.value.replace(/[^0-9A-Fa-f-]/g, '').replace(/-{2,}/g, '-').slice(0, 9))}
                    className="w-full bg-slate-50 border border-emerald-500 rounded-lg px-3 py-2 text-center text-base font-mono text-slate-900 tracking-widest focus:outline-none"
                    autoFocus
                    required
                  />
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center justify-center gap-1.5 transition shadow-sm"
              >
                <LogIn className="h-4 w-4" />
                <span>Giriş Yap</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
