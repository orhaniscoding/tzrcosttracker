import React, { useState } from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { X, Plus, FolderPlus, Trash2 } from 'lucide-react';
import type { Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';

interface CategoryManagerModalProps {
  canManage?: boolean;
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  onAddCategory: (cat: any) => Promise<void>;
  onDeleteCategory: (id: string) => Promise<void>;
}

export const CategoryManagerModal: React.FC<CategoryManagerModalProps> = ({
  canManage = false,
  isOpen,
  onClose,
  categories,
  onAddCategory,
  onDeleteCategory,
}) => {
  const { settings } = useTheme();
  const { t } = useLocale();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [color, setColor] = useState('#3B82F6');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const handleDelete = async (id: string) => {
    if (!canManage) return;
    setError('');
    try { await onDeleteCategory(id); } catch { setError(t('Kategori silinemedi. Yetkinizi ve bağlı kayıtları kontrol edin.', 'Could not delete the category. Check your permissions and linked records.')); }
  };

  if (!isOpen) return null;

  const rootCategories = categories.filter((c) => !c.parentId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || isSubmitting) return;
    setError('');
    if (!name.trim()) return;

    try {
      setIsSubmitting(true);
      await onAddCategory({
        name: name.trim(),
        parentId: parentId || undefined,
        color,
      });
      setName('');
      setParentId('');
    } catch { setError(t('Kategori oluşturulamadı. Lütfen yeniden deneyin.', 'Could not create the category. Please try again.')); } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
        {/* Başlık */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
            <FolderPlus className="h-5 w-5 text-blue-400" />
            {t('Dinamik Kategori & Harcama Başlıkları Yönetimi', 'Dynamic Category & Expense Heading Management')}
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Yeni Kategori Ekleme Formu */}
        {error && <p role="alert" className="text-rose-400 p-4">{error}</p>}
        {canManage && <form onSubmit={handleSubmit} className="p-5 border-b border-slate-800 bg-slate-950/40 grid grid-cols-1 sm:grid-cols-12 gap-3 text-xs">
          <div className="sm:col-span-5">
            <label className="block text-slate-400 font-medium mb-1">{t('Kategori Adı', 'Category Name')} *</label>
            <input
              type="text"
              placeholder={t('Örn: Kaba Yapı, Demir, Sunucu...', 'e.g. Structure, Steel, Server...')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
              required
            />
          </div>

          <div className="sm:col-span-4">
            <label className="block text-slate-400 font-medium mb-1">{t('Üst Başlık (Opsiyonel)', 'Parent Heading (Optional)')}</label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-blue-500 focus:outline-none"
            >
              <option value="">{t('(Ana Kategori)', '(Main Category)')}</option>
              {rootCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-1">
            <label className="block text-slate-400 font-medium mb-1">{t('Renk', 'Color')}</label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-8 bg-transparent cursor-pointer rounded"
            />
          </div>

          <div className="sm:col-span-2 flex items-end">
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full h-9 rounded-lg font-medium text-white flex items-center justify-center gap-1 transition shadow-sm disabled:opacity-50"
              style={{ backgroundColor: settings.primaryColor }}
            >
              <Plus className="h-4 w-4" />
              <span>{t('Ekle', 'Add')}</span>
            </button>
          </div>
        </form>}

        {/* Mevcut Kategoriler Listesi */}
        <div className="p-5 overflow-y-auto flex-1 space-y-3">
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            {t('Tanımlı Hiyerarşi', 'Defined Hierarchy')} ({categories.length} {t('Başlık', 'Headings')})
          </h4>

          {rootCategories.map((root) => {
            const children = categories.filter((c) => c.parentId === root.id);

            return (
              <div key={root.id} className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-3.5 h-3.5 rounded-full"
                      style={{ backgroundColor: root.color }}
                    />
                    <span className="text-sm font-bold text-slate-100">{root.name}</span>
                    <span className="text-[11px] text-slate-400">({children.length} {t('alt başlık', 'subheadings')})</span>
                  </div>
                  {canManage && <button
                    onClick={() => void handleDelete(root.id)}
                    className="p-1 text-slate-500 hover:text-rose-400 rounded transition"
                    title={t('Kategoriyi Sil', 'Delete Category')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>}
                </div>

                {/* Alt Başlıklar */}
                {children.length > 0 && (
                  <div className="mt-2 pl-4 border-l-2 border-slate-800 space-y-1.5">
                    {children.map((sub) => (
                      <div key={sub.id} className="flex items-center justify-between text-xs py-1">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: sub.color }}
                          />
                          <span className="text-slate-300 font-medium">{sub.name}</span>
                        </div>
                        {canManage && <button
                          onClick={() => void handleDelete(sub.id)}
                          className="p-1 text-slate-500 hover:text-rose-400 rounded transition"
                          title={t('Sil', 'Delete')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
