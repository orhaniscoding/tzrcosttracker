import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddKasaModal } from './src/components/AddKasaModal.tsx';

// Synthetic external parent QA. Product component remains real; only useTheme is shimmed.
const ids={R:'11111111-1111-4111-8111-111111111111',C:'22222222-2222-4222-8222-222222222222',N:'33333333-3333-4333-8333-333333333333'};
const baseCatalog=[{id:ids.R,name:'QA258 Kök',color:'#2563eb'},{id:ids.C,parentId:ids.R,name:'QA258 Alt kategori',color:'#15803d'},
  {id:ids.N,name:'QA258 İlk olmayan kategori',color:'#9333ea'}];
const longCategory='QA258 Uzun kategori '+ 'MaliyetKalemi'.repeat(15);
const longPerson=('QA258 Uzun kişi '+ 'OrtakAdı'.repeat(11)).slice(0,99);
const qa=window as any;
qa.__addkasa258Calls={add:[],close:0};
qa.__addkasa258Pending=[];
qa.__addkasa258Settle=(reject=false)=>{
  const pending=qa.__addkasa258Pending.shift();
  if(!pending) throw new Error('No pending QA258 promise.');
  reject?pending.reject(new Error('QA258 synthetic deferred rejection')):pending.resolve();
};
function QA(){
  const [open,setOpen]=useState(false),[catalog,setCatalog]=useState('valid'),[base,setBase]=useState<string|undefined>('USD');
  const [promiseMode,setPromiseMode]=useState('success'),[epoch,setEpoch]=useState(0);
  qa.__addkasa258Set=(options:any)=>{
    if(Object.prototype.hasOwnProperty.call(options,'open'))setOpen(options.open);
    if(Object.prototype.hasOwnProperty.call(options,'catalog'))setCatalog(options.catalog);
    if(Object.prototype.hasOwnProperty.call(options,'base'))setBase(options.base===null?undefined:options.base);
    if(Object.prototype.hasOwnProperty.call(options,'promiseMode'))setPromiseMode(options.promiseMode);
    if(options.fresh)setEpoch(value=>value+1);
  };
  let categories:any[]=baseCatalog;
  if(catalog==='empty')categories=[];
  if(catalog==='invalid')categories=[{id:'not-a-uuid',name:'QA258 Geçersiz kimlik'},{id:'',name:'QA258 Boş kimlik'},{name:'QA258 Eksik kimlik'}];
  if(catalog==='selectedremoved')categories=baseCatalog.filter(category=>category.id!==ids.C);
  if(catalog==='long')categories=baseCatalog.map(category=>category.id===ids.N?{...category,name:longCategory}:category);
  qa.__addkasa258Fixture={open,catalog,base,promiseMode,epoch,ids,longCategory,longPerson};
  const onAdd=(data:any)=>{
    qa.__addkasa258Calls.add.push(JSON.parse(JSON.stringify(data)));
    if(promiseMode==='throw')throw new Error('QA258 synthetic synchronous throw');
    if(promiseMode==='error')return Promise.reject(new Error('QA258 synthetic asynchronous rejection'));
    if(promiseMode==='deferred')return new Promise<void>((resolve,reject)=>qa.__addkasa258Pending.push({resolve,reject}));
    return Promise.resolve();
  };
  return <main style={{padding:16,maxWidth:1440,margin:'auto',minWidth:0}}>
    <header><h1>TZR Cost Tracker — sentetik AddKasa QA258</h1><p>Yalnız sentetik veri. Gerçek firma, kimlik veya mali kayıt yoktur.</p></header>
    <div style={{display:'flex',flexWrap:'wrap',gap:12}}>
      <button id="qa-addkasa258-open" onClick={()=>setOpen(true)}>QA258 Formu aç</button>
      <label>QA katalog <select id="qa-addkasa258-catalog" value={catalog} onChange={e=>setCatalog(e.target.value)}>{['valid','empty','invalid','selectedremoved','long'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label>QA sunucu bazı <select id="qa-addkasa258-base" value={base||'missing'} onChange={e=>setBase(e.target.value==='missing'?undefined:e.target.value)}>{['USD','TRY','missing','US'].map(value=><option key={value}>{value}</option>)}</select></label>
      <label>QA promise <select id="qa-addkasa258-promise" value={promiseMode} onChange={e=>setPromiseMode(e.target.value)}>{['success','error','throw','deferred'].map(value=><option key={value}>{value}</option>)}</select></label>
    </div>
    <div data-testid="addkasa258-component"><AddKasaModal key={epoch} isOpen={open} categories={categories} baseCurrency={base}
      onAdd={onAdd as any} onClose={()=>{qa.__addkasa258Calls.close+=1;setOpen(false);}} /></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<QA />);
