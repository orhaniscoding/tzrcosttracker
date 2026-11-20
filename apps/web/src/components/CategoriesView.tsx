import React, { useRef, useState } from 'react';
import { useLocale } from '../context/LocaleContext.js';
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
  const { t, intlLocale } = useLocale();
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
    try { await onDeleteCategory(id); } catch { setError(t('Kategori silinemedi. Yetkinizi ve bağlı kayıtları kontrol edip yeniden deneyin.', 'Could not delete the category. Check your permissions and linked records, then try again.')); }
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
    } catch { setError(t('Kategori oluşturulamadı. Lütfen yeniden deneyin.', 'Could not create the category. Please try again.')); }
    finally { submitLock.current = false; setIsSubmitting(false); }
  };
  if (isLoading) return <p role="status">{t('Kategori giderleri yükleniyor...', 'Loading category expenses...')}</p>;
  const ids = new Set(categories.map(category => category.id));
  const unknown = transactions.some(t => (t.categoryId != null && !ids.has(t.categoryId)) || (t.subcategoryId != null && !ids.has(t.subcategoryId)));
  const number = (value: number) => new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const inputClass = 'w-full min-w-0 rounded-lg border border-slate-300 px-3 py-2';
  const form = <form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 min-w-0">
    <h3 className="font-bold">{t('Yeni Harcama Başlığı / Kategori Oluştur', 'Create Expense Heading / Category')}</h3>
    <label className="block">{t('Kategori / İş Kalemi Adı *', 'Category / Item Name *')}<input type="text" autoFocus className={inputClass} required placeholder={t('Örn: Kaba Yapı, Hazır Beton, Noter, Asansör...', 'e.g. Structure, Concrete, Notary, Elevator...')} value={name} onChange={e => setName(e.target.value)} /></label>
    <label className="block">{t('Kalem Kodu (Opsiyonel)', 'Item Code (Optional)')}<input type="text" className={inputClass} placeholder={t('Örn: KY-01, NT-04', 'e.g. ST-01, NT-04')} value={code} onChange={e => setCode(e.target.value)} /></label>
    <label className="block">{t('Renk Rozeti', 'Color Badge')}<input type="color" value={color} onChange={e => setColor(e.target.value)} /><input type="text" aria-label={t('Renk kodu', 'Color code')} value={color} onChange={e => setColor(e.target.value)} /></label>
    <label className="block">{t('Hiyerarşi / Üst Başlık Seçimi', 'Hierarchy / Parent Heading')}<select className={inputClass} value={parentId} onChange={e => setParentId(e.target.value)}><option value="">{t('Ana Kategori', 'Main Category')}</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label className="block">{t('Bütçe kaydı (opsiyonel; döviz/dönem/kapsam doğrulanmadı)', 'Budget record (optional; currency, period and scope unverified)')}<input className={inputClass} type="number" step="1" placeholder={t('Sayısal kayıt', 'Numeric value')} value={budget} onChange={e => setBudget(e.target.value)} /></label>
    <p>{t('Bu kayıt için bütçe karşılaştırması ve eşik uyarıları henüz etkin değil.', 'Budget comparisons and threshold alerts are not yet enabled for this record.')}</p>
    <label className="block">{t('Açıklama (Opsiyonel)', 'Description (Optional)')}<textarea className={inputClass} rows={3} placeholder={t('Bu kalem kapsamındaki işler ve şartlar...', 'Work and conditions covered by this item...')} value={description} onChange={e => setDescription(e.target.value)} /></label>
    <button type="submit" disabled={isSubmitting} style={{ backgroundColor: settings.primaryColor }} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{isSubmitting ? t('Kaydediliyor...', 'Saving...') : t('Kategoriyi Sisteme Ekle', 'Add Category')}</button>
  </form>;
  const tree = <section className="space-y-3 min-w-0">
    <h3 className="font-bold">{t('Tanımlı Kategori ve Alt Başlıklar Ağacı', 'Category and Subcategory Tree')}</h3>
    <p>{t('Yüklenen kayıtların kategori ve alt kategori bazında tanınan giderleri.', 'Recognized expenses from loaded records by category and subcategory.')}</p>
    <p>{t('Kategori özetleri örtüşebilir; kartlar toplanarak genel gider elde edilmez.', 'Category summaries may overlap; adding cards does not produce a grand total.')}</p>
    {unknown && <p role="alert">{t('Bazı hareketlerin kategori bağlantısı bu görünümde doğrulanamıyor.', 'Some transaction category links cannot be verified in this view.')}</p>}
    {categories.length === 0 && <p>{t('Henüz kayıtlı bir kategori bulunmuyor.', 'No categories have been recorded yet.')}</p>}
    {categories.map(category => {
      const { finance, hasHierarchyIssue } = computeCategoryExpense(category.id, categories, transactions, currency);
      const parent = categories.find(c => c.id === category.parentId);
      const currencies = Object.keys(finance.byCurrency).filter(c => c !== currency && finance.byCurrency[c].transactionCount > 0).sort();
      return <article key={category.id} aria-label={t('Kategori: ', 'Category: ') + category.name} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 [overflow-wrap:anywhere]">
        <div className="flex flex-wrap items-center gap-2"><span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full" style={{ backgroundColor: category.color }} /><strong>{category.name}</strong>{category.code && <span>{category.code}</span>}{canManage && <button type="button" title={category.parentId ? t('Alt Başlığı Sil', 'Delete Subcategory') : t('Ana Kategoriyi Sil', 'Delete Main Category')} aria-label={(category.parentId ? t('Alt Başlığı Sil: ', 'Delete Subcategory: ') : t('Ana Kategoriyi Sil: ', 'Delete Main Category: ')) + category.name} onClick={() => void handleDelete(category.id)} className="rounded p-2 text-rose-700">{t('Sil', 'Delete')}</button>}</div>
        {parent && <p>{t('Üst başlık:', 'Parent heading:')} {parent.name}</p>}
        {hasHierarchyIssue && <p>{t('Hiyerarşi doğrulanamadı; gider kapsamı eksik olabilir.', 'The hierarchy could not be verified; expense coverage may be incomplete.')}</p>}
        <p>{number(finance.totalExpense)} {currency}</p>{currencies.map(c => <p key={c}>{number(finance.byCurrency[c].totalExpense)} {c}</p>)}
        <p>{category.budget == null ? t('Bütçe bilgisi bu görünümde sunulmuyor', 'Budget information is not available in this view') : Number.isFinite(category.budget) ? t('Bütçe kaydı: ', 'Budget record: ') + category.budget + t(' — döviz/dönem/kapsam doğrulaması bekliyor', ' — currency, period and scope await verification') : t('Bütçe kaydı doğrulanamıyor', 'Budget record cannot be verified')}</p>
      </article>;
    })}
  </section>;
  return <div className="space-y-4 min-w-0"><h2 className="font-bold">{t('Kategori & İş Kalemleri Yönetim Merkezi', 'Category & Item Management')}</h2>{error && <p role="alert">{error}</p>}{canManage && onNavigateToTree && <button type="button" onClick={() => { if (!isLoading && canManage) onNavigateToTree(); }} className="rounded border px-3 py-2">{subView === 'new' ? t('Kategori Ağacına Dön', 'Back to Category Tree') : t('Yeni Kategori Ekle', 'Add Category')}</button>}{!canManage || subView === 'tree' ? tree : subView === 'new' ? form : <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">{tree}<form onSubmit={handleSubmit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 min-w-0"><input type="text" className={inputClass} placeholder={t('Kategori Adı', 'Category Name')} value={name} onChange={e => setName(e.target.value)} required /><button type="submit" disabled={isSubmitting} className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{t('Ekle', 'Add')}</button></form></div>}</div>;
};
