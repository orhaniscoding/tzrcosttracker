import React, { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { AccountManagementController, accountNumericInput, defaultAccountProject, useFormLifetime, type ProjectOption } from '../account-management.js';
import { canMutateAccounts, canReassignAccountProject } from '../view-access.js';
import { useTheme } from '../context/ThemeContext.js';

interface LiquidityHubViewProps {
  role?: string; projects?: ProjectOption[]; selectedProjectId?: string | null;
  onDataChanged?: () => void | Promise<void>;
}
const emptyProjects: ProjectOption[] = [];
export const AccountTypeOptions = () => {
  const { t } = useLocale();
  return <>{[['bank', t('Banka', 'Bank')], ['cash', t('Nakit Kasa', 'Cash')], ['credit_card', t('Kredi Kartı', 'Credit Card')], ['pos', 'POS'], ['other', t('Diğer', 'Other')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>;
};
export const LiquidityHubView: React.FC<LiquidityHubViewProps> = ({ role, projects = emptyProjects, selectedProjectId = null, onDataChanged }) => {
  const { settings } = useTheme();
  const { t, intlLocale } = useLocale();
  const localize = t;
  const [controller] = useState(() => new AccountManagementController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<Record<string, any> | null>(null);
  const canMutate = canMutateAccounts(role);
  const lifetime = useFormLifetime(selectedProjectId, canMutate);
  // Fresh project objects from a background parent read are not a new scope.
  const membershipKey = JSON.stringify(projects.map(p => p.id).sort());
  useLayoutEffect(() => { setDraft(null); setTransfer(null); setEditingId(null); }, [lifetime.generation]);
  useLayoutEffect(controller.connect, [controller]);
  useLayoutEffect(() => {
    controller.configure({ role, projects, selectedProjectId, onDataChanged });
    setDraft(null); setTransfer(null); setEditingId(null); void controller.reload();
    return () => controller.configure({ projects: [] });
  }, [controller, role, membershipKey, selectedProjectId, onDataChanged]);
  const money = (value: number, currency = settings.baseCurrency || 'TRY') => new Intl.NumberFormat(intlLocale, { style: 'currency', currency }).format(value);
  const field = (name: string, value: any) => setDraft(d => d ? { ...d, [name]: value } : null);
  const openCreate = () => {
    if (!canMutate) return;
    setEditingId(null); setDraft({ name: '', type: 'bank', currency: 'TRY', initialBalance: 0, creditLimit: 0, projectId: defaultAccountProject({ role, projects, selectedProjectId }) });
  };
  const openEdit = (account: any) => { if (!canMutate) return; setEditingId(account.id); setDraft({ ...account, initialBalance: account.initialBalance ?? account.balance }); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!canMutate || !draft) return;
    const current = lifetime.capture(); if (!current()) return;
    const saved = await (editingId ? controller.update(editingId, draft) : controller.create(draft));
    if (saved && current()) { setDraft(null); setEditingId(null); }
  };
  return <section className="space-y-5 max-w-6xl">
    <header className="bg-white border rounded-xl p-5 space-y-3">
      <h2 className="font-bold">{t("Merkezi Likidite & Cüzdanlar Hub'ı (Liquidity Hub)", 'Central Liquidity & Wallet Hub')}</h2>
      <p className="text-xs">{selectedProjectId ? 'Seçili şantiye cüzdanları' : 'Erişilebilir tüm cüzdanlar'}</p>
      <button onClick={() => void controller.reload()}>{t('Yeniden dene / Yenile', 'Retry / Refresh')}</button>
      {canMutate && <div className="flex gap-4">
        <button onClick={openCreate}>+ {t('Yeni Cüzdan / Hesap Ekle', 'Add Wallet / Account')}</button>
        <button disabled={state.accounts.length < 2 || state.pending} onClick={() => { if (canMutate) setTransfer({ fromAccountId: '', toAccountId: '', amount: '', exchangeRate: 1, description: '' }); }}>{t('İç Transfer / Virman Yap', 'Make Internal Transfer')}</button>
      </div>}
      {state.error && <p role="alert" className="text-rose-700">{state.error}</p>}
      {state.notice && <p role="status">{state.notice}</p>}
    </header>
    {state.loading && <p role="status">{t('Cüzdanlar ve likidite yükleniyor…', 'Loading wallets and liquidity…')}</p>}
    {state.summary && <div className="grid grid-cols-2 gap-4 bg-white rounded-xl p-5">
      {([[t('Banka & POS Likiditesi', 'Bank & POS Liquidity'), 'totalBankBase'], [t('Nakit Kasa Mevcudu', 'Cash on Hand'), 'totalCashBase'], [t('Kredi Kartı Borç Yükü', 'Credit Card Debt'), 'totalCreditCardDebtBase'], [t('Net Kullanılabilir Likidite', 'Net Available Liquidity'), 'netLiquidityAfterCC']] as const).map(([label, key]) => <div key={key}><h3>{label}</h3><strong>{money(state.summary[key])}</strong></div>)}
    </div>}
    {!state.loading && !state.error && state.summary && !state.accounts.length && <p>{t('Henüz kayıtlı bir cüzdan bulunmuyor.', 'No wallets have been recorded yet.')}</p>}
    <div className="grid md:grid-cols-3 gap-4">{state.accounts.map(account => <article key={account.id} className="bg-white border rounded-xl p-5 space-y-2">
      <h3 className="font-bold">{account.name}</h3><p>{account.type} · {account.bankName}</p>
      <p>{money(account.balance, account.currency)}</p><p>{account.iban}</p><p>{account.description}</p>
      {account.type === 'credit_card' && <p>Limit: {money(account.creditLimit || 0, account.currency)} · Kesim: {account.statementClosingDay || '—'}{localize(" · Son ödeme: ", " · Last payment: ")}{account.paymentDueDay || '—'}</p>}
      {canMutate && <div className="flex gap-3"><button disabled={state.pending} onClick={() => openEdit(account)}>{t('Hesabı Düzenle', 'Edit Account')}</button><button disabled={state.pending} onClick={() => { if (canMutate && confirm(t('Hesap silinsin mi?', 'Delete this account?'))) void controller.delete(account.id); }}>{t('Hesabı Sil', 'Delete Account')}</button></div>}
    </article>)}</div>
    {canMutate && draft && <form onSubmit={save} className="bg-white border rounded-xl p-5 space-y-3" aria-label={t('Cüzdan formu', 'Wallet form')}>
      <h3 className="font-bold">{editingId ? 'Cüzdanı Düzenle' : 'Yeni Cüzdan / Hesap Tanımla'}</h3>
      {(!editingId || canReassignAccountProject(role)) && <label className="block">{localize("Şantiye", "Project")}
        <select required={role !== 'admin'} value={draft.projectId ?? ''} onChange={e => field('projectId', e.target.value || null)}>
          {role === 'admin' && <option value="">{t('Genel / Şantiyesiz', 'General / No Site')}</option>}
          {projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>}
          <label className="block">{t('Hesap / Kasa Adı', 'Account / Cash Name')} * <input required value={draft.name} onChange={e => field('name', e.target.value)} /></label>
      <label className="block">{t('Hesap Türü', 'Account Type')} <select value={draft.type} onChange={e => field('type', e.target.value)}><AccountTypeOptions /></select></label>
      <label className="block">{t('Para Birimi', 'Currency')} <select value={draft.currency} onChange={e => field('currency', e.target.value)}>{['TRY', 'USD', 'EUR', 'GBP'].map(c => <option key={c}>{c}</option>)}</select></label>
      {([['initialBalance', t('Açılış Reel Bakiyesi', 'Opening Balance')], ['creditLimit', t('Kredi Limiti', 'Credit Limit')], ['statementClosingDay', t('Kesim Günü', 'Statement Closing Day')], ['paymentDueDay', t('Son Ödeme Günü', 'Payment Due Day')]] as const).map(([key, label]) => <label className="block" key={key}>{label} <input type="number" step={key.endsWith('Day') ? '1' : '0.01'} min={key.endsWith('Day') ? 1 : undefined} max={key.endsWith('Day') ? 31 : undefined} value={draft[key] ?? ''} onChange={e => field(key, accountNumericInput(key, e.target.value))} /></label>)}
      {([['bankName', t('Banka Adı', 'Bank Name')], ['iban', 'IBAN'], ['description', t('Açıklama', 'Description')]] as const).map(([key, label]) => <label className="block" key={key}>{label} <input value={draft[key] ?? ''} onChange={e => field(key, e.target.value)} /></label>)}
      <p className="text-xs">{t('Mali geçmişi olan hesaplarda proje, para birimi ve açılış bakiyesi değişikliği reddedilebilir.', 'Changes to project, currency and opening balance may be rejected for accounts with financial history.')}</p>
      <button disabled={state.pending} type="submit">{t('Hesabı Kaydet', 'Save Account')}</button> <button type="button" onClick={() => setDraft(null)}>{t('Kapat', 'Close')}</button>
    </form>}
    {canMutate && transfer && <form className="bg-white border rounded-xl p-5 space-y-3" onSubmit={async e => { e.preventDefault(); if (!canMutate) return; const current = lifetime.capture(); if (!current()) return; const saved = await controller.transfer({ ...transfer, amount: Number(transfer.amount), exchangeRate: Number(transfer.exchangeRate) }); if (saved && current()) setTransfer(null); }}>
      <h3>{t('İç Transfer / Virman (P&L Nötr)', 'Internal Transfer (P&L Neutral)')}</h3>
      {(['fromAccountId', 'toAccountId'] as const).map(key => <label className="block" key={key}>{key === 'fromAccountId' ? t('Kaynak Cüzdan', 'Source Wallet') : t('Hedef Cüzdan', 'Destination Wallet')}<select required value={transfer[key]} onChange={e => setTransfer({ ...transfer, [key]: e.target.value })}><option value="">{t('Cüzdan seçin', 'Select a wallet')}</option>{state.accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</select></label>)}
      <label className="block">{t('Tutar', 'Amount')} <input required type="number" min="0.01" step="0.01" value={transfer.amount} onChange={e => setTransfer({ ...transfer, amount: e.target.value })} /></label>
      <label className="block">{t('Döviz Kuru', 'Exchange Rate')} <input required type="number" min="0.0001" step="0.0001" value={transfer.exchangeRate} onChange={e => setTransfer({ ...transfer, exchangeRate: e.target.value })} /></label>
      <label className="block">{t('Açıklama', 'Description')} <input value={transfer.description} onChange={e => setTransfer({ ...transfer, description: e.target.value })} /></label>
      <button disabled={state.pending} type="submit">{t('Virmanı Tamamla', 'Complete Transfer')}</button> <button type="button" onClick={() => setTransfer(null)}>{t('Kapat', 'Close')}</button>
    </form>}
  </section>;
};
