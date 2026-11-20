import React, { useRef, useState } from 'react';
import type { Category, Transaction } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';
import { computeCategoryExpense } from '../category-finance.js';

interface CategoriesViewProps {
  canManage?: boolean;
  categories: Category[];
  transactions?: Transaction[];
  onAddCategory: (cat: any) => Promise<void>;
  onDeleteCategory: (id: string) => Promise<void>;
  subView?: 'tree' | 'new';
  onNavigateToTree?: () => void;
  baseCurrency?: string;
  isLoading?: boolean;
}

export const CategoriesView: React.FC<CategoriesViewProps> = ({ canManage = false, categories, transactions = [], onAddCategory, onDeleteCategory, subView, onNavigateToTree, baseCurrency, isLoading = false }) => {
  const { settings } = useTheme();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState('');
  const [budget, setBudget] = useState('');
  const [color, setColor] = useState('#2563EB');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submitLock = useRef(false);
  const currency = baseCurrency || settings.baseCurrency || 'TRY';
  const handleDelete = async (id: string) => {
    if (isLoading || !canManage) return;
    setError('');
    try { await onDeleteCategory(id); } catch { setError('Kategori silinemedi. Yetkinizi ve bağlı kayıtları kontrol edip yeniden deneyin.'); }
  };
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading || !canManage || isSubmitting || submitLock.current) return;
    setError('');
    if (!name.trim()) return;
    submitLock.current = true;
    setIsSubmitting(true);
    try {
      await onAddCategory({ name: name.trim(), code: code.trim() || undefined, parentId: parentId || undefined, budget: budget ? parseFloat(budget) : 0, color, description: description.trim() || undefined });
      setName(''); setCode(''); setParentId(''); setBudget(''); setDescription('');
    } catch { setError('Kategori oluşturulamadı. Lütfen yeniden deneyin.'); }
    finally { submitLock.current = false; setIsSubmitting(false); }
  };
  if (isLoading) return <p role="status">Kategori giderleri yükleniyor...</p>;
  const ids = new Set(categories.map(category => category.id));
  const unknown = transactions.some(t => (t.categoryId != null && !ids.has(t.categoryId)) || (t.subcategoryId != null && !ids.has(t.subcategoryId)));
  const number = (value: number) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const inputClass = 'w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2';
  const form = <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 min-w-0">
    <h3 className="font-bold">Yeni Harcama Başlığı / Kategori Oluştur</h3>
    <label className="block">Kategori / İş Kalemi Adı *<input type="text" autoFocus className={inputClass} required placeholder="Örn: Kaba Yapı, Hazır Beton, Noter, Asansör..." value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="block">Kalem Kodu (Opsiyonel)<input type="text" className={inputClass} placeholder="Örn: KY-01, NT-04" value={code} onChange={e => setCode(e.target.value)} /></label>
    <label className="block">Renk Rozeti<input type="color" value={color} onChange={e => setColor(e.target.value)} /><input type="text" aria-label="Renk kodu" value={color} onChange={e => setColor(e.target.value)} /></label>
    <label className="block">Hiyerarşi / Üst Başlık Seçimi<select className={inputClass} value={parentId} onChange={e => setParentId(e.target.value)}><option value="">Ana Kategori</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label className="block">Bütçe kaydı (opsiyonel; döviz/dönem/kapsam doğrulanmadı)<input className={inputClass} type="number" step="1" placeholder="Sayısal kayıt" value={budget} onChange={e => setBudget(e.target.value)} /></label>
    <p>Bu kayıt için bütçe karşılaştırması ve eşik uyarıları henüz etkin değil.</p>
    <label className="block">Açıklama (Opsiyonel)<textarea className={inputClass} rows={3} placeholder="Bu kalem kapsamındaki işler ve şartlar..." value={description} onChange={e => setDescription(e.target.value)} /></label>
    <button type="submit" disabled={isSubmitting} style={{ backgroundColor: settings.primaryColor }} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{isSubmitting ? 'Kaydediliyor...' : 'Kategoriyi Sisteme Ekle'}</button>
  </form>;
  const tree = <section className="space-y-3 min-w-0">
    <h3 className="font-bold">Tanımlı Kategori ve Alt Başlıklar Ağacı</h3>
    <p>Yüklenen kayıtların kategori ve alt kategori bazında tanınan giderleri.</p>
    <p>Kategori özetleri örtüşebilir; kartlar toplanarak genel gider elde edilmez.</p>
    {unknown && <p role="alert">Bazı hareketlerin kategori bağlantısı bu görünümde doğrulanamıyor.</p>}
    {categories.length === 0 && <p>Henüz kayıtlı bir kategori bulunmuyor.</p>}
    {categories.map(category => {
      const { finance, hasHierarchyIssue } = computeCategoryExpense(category.id, categories, transactions, currency);
      const parent = categories.find(c => c.id === category.parentId);
      const currencies = Object.keys(finance.byCurrency).filter(c => c !== currency && finance.byCurrency[c].transactionCount > 0).sort();
      return <article key={category.id} aria-label={'Kategori: ' + category.name} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center gap-2"><span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: category.color }} /><strong>{category.name}</strong>{category.code && <span>{category.code}</span>}{canManage && <button type="button" title={category.parentId ? 'Alt Başlığı Sil' : 'Ana Kategoriyi Sil'} aria-label={(category.parentId ? 'Alt Başlığı Sil: ' : 'Ana Kategoriyi Sil: ') + category.name} onClick={() => void handleDelete(category.id)} className="rounded p-2 text-rose-700">Sil</button>}</div>
        {parent && <p>Üst başlık: {parent.name}</p>}
        {hasHierarchyIssue && <p>Hiyerarşi doğrulanamadı; gider kapsamı eksik olabilir.</p>}
        <p>{number(finance.totalExpense)} {currency}</p>{currencies.map(c => <p key={c}>{number(finance.byCurrency[c].totalExpense)} {c}</p>)}
        <p>{category.budget == null ? 'Bütçe bilgisi bu görünümde sunulmuyor' : Number.isFinite(category.budget) ? 'Bütçe kaydı: ' + category.budget + ' — döviz/dönem/kapsam doğrulaması bekliyor' : 'Bütçe kaydı doğrulanamıyor'}</p>
      </article>;
    })}
  </section>;
  return <div className="space-y-4 min-w-0"><h2 className="font-bold">Kategori &amp; İş Kalemleri Yönetim Merkezi</h2>{error && <p role="alert">{error}</p>}{canManage && onNavigateToTree && <button type="button" onClick={() => { if (!isLoading && canManage) onNavigateToTree(); }} className="rounded border px-3 py-2">{subView === 'new' ? 'Kategori Ağacına Dön' : 'Yeni Kategori Ekle'}</button>}{!canManage || subView === 'tree' ? tree : subView === 'new' ? form : <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">{tree}<form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 min-w-0"><input type="text" className={inputClass} placeholder="Kategori Adı" value={name} onChange={e => setName(e.target.value)} required /><button type="submit" disabled={isSubmitting} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">Ekle</button></form></div>}</div>;
};
