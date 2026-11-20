const fs=require('fs'),path=require('path'),{createRequire}=require('module'),assert=require('assert/strict');
// PREPARED ONLY. Parent runs after final Terra bundle/build. No API/auth/server is used.
const url='http://tzrcosttracker.test/',fixedNow='2026-11-14T12:30:00.000Z';
const ids={R:'11111111-1111-4111-8111-111111111111',C:'22222222-2222-4222-8222-222222222222',N:'33333333-3333-4333-8333-333333333333'};
const checkpoints=[];
(async()=>{
  const opts={};
  const allowed=new Set(['--fixture-root','--assets','--output','--playwright-modules','--browser-executable']);
  for(let i=2;i<process.argv.length;i++){const key=process.argv[i];if(!allowed.has(key)||opts[key]||!process.argv[i+1]||process.argv[i+1].startsWith('--'))throw new Error('Unknown, duplicate or missing argument: '+key);opts[key]=process.argv[++i];if(!path.isAbsolute(opts[key]))throw new Error(key+' must be an absolute path.');}
  const fixture=path.resolve(opts['--fixture-root']||path.join(__dirname,'../../../..'));
  const assets=path.resolve(opts['--assets']||path.join(fixture,'apps/web/dist/assets'));
  if(!opts['--output'])throw new Error('--output ABS_QA_OUTPUT is required and must not exist.');
  const output=path.resolve(opts['--output']);
  const inside=(child,parent)=>{const rel=path.relative(parent,child);return rel.length===0 || (!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
  if(inside(output,path.join(fixture,'apps/web/src'))||inside(output,path.join(fixture,'apps/web/dist'))||inside(output,__dirname)||inside(output,assets))throw new Error('Output must be outside source, dist, assets and test scripts.');
  fs.mkdirSync(output);
  let chromium;try{({chromium}=opts['--playwright-modules']?createRequire(path.join(opts['--playwright-modules'],'__costtracker_qa__.cjs'))('playwright'):require('playwright'));}catch(error){throw new Error('Playwright unavailable; provide --playwright-modules ABS_NODE_MODULES for an existing installation. No installation is performed. '+error.message);}
  await require('./add-kasa-bundle.cjs').build(fixture,output);
  const cssNames=fs.readdirSync(assets).filter(name=>name.endsWith('.css')).sort();
  assert.ok(cssNames.length,'Final fixture built CSS is required.');
  const css=cssNames.map(name=>fs.readFileSync(path.join(assets,name),'utf8')).join('\n');
  const script=fs.readFileSync(path.join(output,'add-kasa-bundle.js'),'utf8');
  const html='<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TZR Cost Tracker — AddKasa QA258</title><link rel="icon" href="data:,"><style>'+css.replaceAll('</style','<\\/style')+'</style></head><body><div id="root"></div><script>'+script.replaceAll('</script','<\\/script')+'</script></body></html>';
  let browser;try{browser=await chromium.launch(opts['--browser-executable']?{executablePath:opts['--browser-executable'],headless:true}:{headless:true});}catch(error){throw new Error('Browser launch failed; provide --browser-executable ABS_BROWSER_EXE or an existing Playwright browser. No download is performed. '+error.message);}
  const errors=[],blockedRequests=[],expectedNativeWarnings=[];let adversarialAmountSeam=false;
  let page;
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Europe/Istanbul',serviceWorkers:'block'});
    await context.addInitScript(instant=>{const OriginalDate=Date,epoch=OriginalDate.parse(instant);window.Date=class extends OriginalDate{constructor(...args){if(args.length===0)super(epoch);else super(...args);}static now(){return epoch;}};},fixedNow);
    await context.route('**/*',route=>{
      if(route.request().url()===url&&route.request().resourceType()==='document')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
      blockedRequests.push(route.request().url());return route.abort();
    });
    page=await context.newPage();page.setDefaultTimeout(8000);
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{const t=message.text();if(adversarialAmountSeam&&message.type()==='warning'&&/^The specified value "(?:12junk|Infinity|NaN|1e309)" cannot be parsed, or is out of range\.$/.test(t)){expectedNativeWarnings.push(t);return;}if(['error','warning'].includes(message.type()))errors.push(t);});
    await page.goto(url);
    assert.equal(page.url(),url);assert.equal(await page.title(),'TZR Cost Tracker — AddKasa QA258');
    await page.locator('#qa-addkasa258-open').waitFor();
    const component=page.getByTestId('addkasa258-component');
    const form=()=>component.locator('form');
    const person=()=>component.getByLabel(/Kasaya Parayı Koyan|Kişi.*Ortak/i);
    const date=()=>component.getByLabel(/^Tarih\b/i);
    const amount=()=>component.getByLabel(/^Tutar\b/i);
    const category=()=>component.getByLabel(/Kategori/i);
    const description=()=>component.getByPlaceholder('Örn: 1. Hak ediş öncesi avans',{exact:true});
    const submit=()=>form().locator('button[type="submit"]');
    const cancel=()=>component.getByRole('button',{name:'Vazgeç',exact:true});
    const calls=()=>page.evaluate(()=>JSON.parse(JSON.stringify(window.__addkasa258Calls)));
    async function configure(options){
      const epoch=await page.evaluate(()=>window.__addkasa258Fixture.epoch);
      await page.evaluate(options=>window.__addkasa258Set(options),options);
      await page.waitForFunction(({options,epoch})=>{
        const current=window.__addkasa258Fixture;
        return Object.entries(options).every(([key,value])=>key==='fresh'?!value||current.epoch===epoch+1:current[key]===(key==='base'&&value===null?undefined:value));
      },{options,epoch});
    }
    const fresh=async(options={})=>{await configure({fresh:true,open:true,catalog:'valid',base:'USD',promiseMode:'success',...options});await form().waitFor();};
    const forceSubmit=()=>form().evaluate(element=>element.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    const duplicateSubmit=()=>form().evaluate(element=>{element.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));element.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
    async function snapshot(){return{person:await person().inputValue(),date:await date().inputValue(),amount:await amount().inputValue(),description:await description().inputValue(),category:await category().inputValue()};}
    async function fill({name='QA258 Sentetik Kişi',dateValue='2026-11-11',amountValue='54.32',descriptionValue='QA258 Özel açıklama',categoryId=ids.C}={}){
      await person().fill(name);await date().fill(dateValue);await amount().fill(amountValue);await description().fill(descriptionValue);await category().selectOption(categoryId);
    }
    async function currency(code,{allowOld=false}={}){
      await page.waitForFunction(code=>new RegExp('\\b'+code+'\\b').test(document.querySelector('[data-testid="addkasa258-component"]').innerText),code);
      const text=await component.innerText();
      assert.match(text,new RegExp('\\b'+code+'\\b'),'Authoritative/entered currency must be visibly identified.');
      assert.ok(!/\bEUR\b/.test(text),'Conflicting theme EUR must never author/display this draft currency.');
      assert.equal(await component.locator('select').count(),1,'Category selector only; do not invent editable currency catalog.');
      assert.equal(await component.locator('input').evaluateAll(inputs=>inputs.filter(input=>!input.readOnly&&['USD','TRY','EUR'].includes(input.value)).length),0,'Currency display must not be editable.');
      if(code==='TRY'&&!allowOld)assert.ok(!/\bUSD\b/.test(text),'Empty or re-entered amount must adopt new base.');
    }
    const expectedPayload=(draft,currencyCode)=>({type:'income',date:new Date(draft.date).toISOString(),amount:Number(draft.amount),currency:currencyCode,categoryId:draft.category,
      title:'Kasa Girişi ('+draft.person+')',description:draft.description||'Doğrudan Kasa Girişi ['+draft.person+']',party:draft.person,payerPersonName:draft.person,
      paymentSource:'company_account',paymentMethod:'Banka',isPaid:true});
    async function waitClosed(previousClose){await page.waitForFunction(count=>window.__addkasa258Calls.close===count,previousClose+1);assert.equal(await form().count(),0);}
    async function assertReset(retainedDate,code){
      await configure({open:true});await form().waitFor();
      assert.deepEqual(await snapshot(),{person:'',date:retainedDate,amount:'',description:'',category:''},'Success clears person/amount/description/category, retaining date.');
      await currency(code);
    }
    async function noOverflow(){const geometry=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth}));assert.ok(geometry.documentWidth<=geometry.width+1&&geometry.bodyWidth<=geometry.width+1,JSON.stringify(geometry));return geometry;}
    async function assertNoAdd(before){assert.equal((await calls()).add.length,before,'Invalid/blocked form must never call onAdd.');}

    assert.equal(await form().count(),0,'Initially closed modal renders no form.');
    await page.locator('#qa-addkasa258-open').click();await form().waitFor();
    assert.equal(await category().inputValue(),'','No first-category default.');
    for(const id of Object.values(ids))assert.equal(await category().locator('option[value="'+id+'"]').count(),1,'Every valid root/child/non-first category is selectable.');
    await currency('USD');
    assert.equal(await component.locator('vite-error-overlay,nextjs-portal,#webpack-dev-server-client-overlay').count(),0);
    const initial=await calls();
    await person().fill('QA258 Başlangıç');await amount().fill('10');await date().fill('2026-11-11');
    assert.equal(await submit().isDisabled(),true,'Category selection is mandatory.');
    await forceSubmit();await assertNoAdd(initial.add.length);
    await fresh({promiseMode:'deferred'});await fill({amountValue:'123.4567'});
    const draft=await snapshot(),beforeDeferred=await calls();
    await noOverflow();await page.screenshot({path:path.join(output,'addkasa258-desktop.png'),fullPage:false});
    await duplicateSubmit();
    await page.waitForFunction(count=>window.__addkasa258Calls.add.length===count,beforeDeferred.add.length+1);
    assert.equal((await calls()).add.length,beforeDeferred.add.length+1,'Same-turn duplicate submits use a synchronous lock.');
    assert.equal(await submit().isDisabled(),true,'Deferred request visibly locks submit.');
    assert.deepEqual((await calls()).add.at(-1),expectedPayload(draft,'USD'),'Exact income payload, no status/FX/baseAmount/project/wallet additions and no amount rounding.');
    assert.deepEqual(await snapshot(),draft);assert.equal((await calls()).close,beforeDeferred.close);
    await page.evaluate(()=>window.__addkasa258Settle(false));await waitClosed(beforeDeferred.close);await assertReset(draft.date,'USD');
    checkpoints.push('Closed/open lifecycle; initially blank exact UUID category; all catalog choices; serverUSD over themeEUR; exact unrounded payload; same-turn/deferred lock; success reset/date/one close');

    await fresh({promiseMode:'error'});await fill({descriptionValue:''});
    const asyncDraft=await snapshot(),beforeError=await calls();
    await submit().click();await component.getByRole('alert').first().waitFor();
    assert.equal((await calls()).add.length,beforeError.add.length+1);assert.equal((await calls()).close,beforeError.close);
    assert.deepEqual(await snapshot(),asyncDraft,'Async failure preserves every value.');assert.equal(await submit().isDisabled(),false);
    assert.deepEqual((await calls()).add.at(-1),expectedPayload(asyncDraft,'USD'),'Original default description retained.');
    await configure({promiseMode:'success'});await submit().click();await waitClosed(beforeError.close);await assertReset(asyncDraft.date,'USD');
    await fresh({promiseMode:'throw'});await fill({amountValue:'65.43'});
    const throwDraft=await snapshot(),beforeThrow=await calls();
    await submit().click();await component.getByRole('alert').first().waitFor();
    assert.deepEqual(await snapshot(),throwDraft);assert.equal((await calls()).close,beforeThrow.close);assert.equal((await calls()).add.length,beforeThrow.add.length+1);
    assert.equal(await submit().isDisabled(),false,'Synchronous throw releases lock.');
    await configure({promiseMode:'success'});await submit().click();await waitClosed(beforeThrow.close);
    checkpoints.push('Async rejection and synchronous throw alert/preserve all draft values/no close; lock releases; retry succeeds; original custom/default descriptions');

    for(const catalog of ['empty','invalid']){
      await fresh({catalog});const before=await calls();
      assert.equal(await submit().isDisabled(),true,catalog+' catalog disables submit.');
      assert.match(await component.innerText(),/kategori/i,'No-valid-category explanation must remain visible.');
      if(await category().count())assert.ok(!(await category().locator('option').evaluateAll(options=>options.some(option=>['not-a-uuid','undefined'].includes(option.value)&&!option.disabled))),'Invalid IDs cannot be enabled category choices.');
      await forceSubmit();await assertNoAdd(before.add.length);
    }
    await fresh();await fill();const removedDraft=await snapshot(),beforeRemoval=await calls();
    await configure({catalog:'selectedremoved'});
    await page.waitForFunction(id=>!Array.from(document.querySelector('[data-testid="addkasa258-component"] select').options).some(option=>option.value===id),ids.C);
    assert.equal(await submit().isDisabled(),true,'Removed selected category blocks submit.');
    assert.notEqual(await category().inputValue(),ids.R,'Removed selection never silently falls back to first category.');
    await forceSubmit();await assertNoAdd(beforeRemoval.add.length);
    assert.equal(await person().inputValue(),removedDraft.person);assert.equal(await amount().inputValue(),removedDraft.amount);
    checkpoints.push('Empty/invalid UUID catalogs disable and explain; selected category removal blocks without first-category substitution or unrelated value loss');

    await fresh();await fill();const beforeInvalid=await calls();
    await person().fill('   ');await forceSubmit();await assertNoAdd(beforeInvalid.add.length);await person().fill('QA258 Sentetik Kişi');
    await date().fill('');await forceSubmit();await assertNoAdd(beforeInvalid.add.length);await date().fill('2026-11-11');
    // Real number inputs sanitize partial/nonfinite strings before React can receive them.
    // Temporarily exposing text input permits a public DOM-level adversarial validation test, with no React internals.
    const originalAmountType=await amount().getAttribute('type');await amount().evaluate(input=>{input.type='text';});
    adversarialAmountSeam=true;
    for(const bad of ['', '0', '-1', '12junk', 'Infinity', 'NaN', '1e309']){
      await amount().evaluate(input=>{input.type='text';});
      await amount().fill(bad);assert.ok([bad,''].includes(await amount().inputValue()),'React may restore number type and sanitize invalid text; never accept a partial valid number.');
      await forceSubmit();await assertNoAdd(beforeInvalid.add.length);
    }
    await amount().evaluate((input,type)=>{input.type=type||'number';},originalAmountType);await amount().fill('54.32');
    adversarialAmountSeam=false;
    checkpoints.push('Handler rejects blank person/date, empty/zero/negative/partial/nonfinite amount without callback; adversarial text values use public DOM type seam only');

    for(const base of [null,'US','USDX']){
      await fresh({base});const before=await calls();
      assert.equal(await submit().isDisabled(),true,'Missing/malformed authoritative base blocks submit.');
      assert.ok(!/\bEUR\b/.test(await component.innerText()),'No theme currency fallback for financial writes.');
      await forceSubmit();await assertNoAdd(before.add.length);
    }
    await fresh();await fill({amountValue:'100.25'});const oldCurrencyDraft=await snapshot(),beforeChange=await calls();
    await configure({base:'TRY'});await component.getByRole('alert').first().waitFor();
    await currency('USD');
    assert.ok((await component.getByRole('alert').first().innerText()).includes('TRY'),'Warning must visibly identify the new server base while retaining USD.');
    assert.match(await component.innerText(),/temiz|yeniden|tekrar/i,'Currency-change warning explains explicit clearing/re-entry.');
    assert.equal(await submit().isDisabled(),true);assert.deepEqual(await snapshot(),oldCurrencyDraft);await forceSubmit();await assertNoAdd(beforeChange.add.length);
    await cancel().click();assert.equal((await calls()).close,beforeChange.close+1);assert.equal(await form().count(),0);
    await configure({open:true});await form().waitFor();await currency('USD');assert.ok((await component.getByRole('alert').first().innerText()).includes('TRY'),'Reopened warning identifies the current server base.');assert.deepEqual(await snapshot(),oldCurrencyDraft,'Manual cancel/reopen preserves draft and its entered currency.');
    assert.equal(await submit().isDisabled(),true,'Reopen must not silently relabel populated draft.');
    await amount().fill('');
    await page.waitForFunction(()=>{const text=document.querySelector('[data-testid="addkasa258-component"]').innerText;return /\bTRY\b/.test(text)&&!/\bUSD\b/.test(text);});
    await currency('TRY');
    assert.deepEqual(await snapshot(),{...oldCurrencyDraft,amount:''},'Explicit amount clear adopts new base and preserves other fields.');
    await amount().fill('77.1234');const newCurrencyDraft=await snapshot(),beforeNewCurrency=await calls();
    await forceSubmit();await waitClosed(beforeNewCurrency.close);
    assert.deepEqual((await calls()).add.at(-1),expectedPayload(newCurrencyDraft,'TRY'));await assertReset(oldCurrencyDraft.date,'TRY');
    await amount().fill('');await configure({base:'USD'});await currency('USD');
    checkpoints.push('Missing/malformed base cannot fall back to theme; populated draft stays USD and blocks on serverTRY; cancel/reopen retains warning; explicit amount clear adopts TRY; re-entry submits exact amount and success resets to current base');

    await page.setViewportSize({width:390,height:844});await fresh({catalog:'long',promiseMode:'error'});
    const long=await page.evaluate(()=>({person:window.__addkasa258Fixture.longPerson,category:window.__addkasa258Fixture.longCategory}));
    await fill({name:long.person,amountValue:'1234567890123.45',categoryId:ids.N,descriptionValue:'QA258 Uzun not '+ 'SentetikAçıklama '.repeat(16)});
    assert.equal(await person().inputValue(),long.person);assert.equal(await amount().inputValue(),'1234567890123.45');
    assert.ok((await category().locator('option:checked').textContent()).includes(long.category),'Full long category accessible option preserved.');
    await currency('USD');const mobileDraft=await snapshot(),beforeMobile=await calls();
    const mobileGeometry=await noOverflow();await page.screenshot({path:path.join(output,'addkasa258-mobile.png'),fullPage:false});
    await date().focus();let reached=false;
    for(let index=0;index<30;index++){
      if(await submit().evaluate(element=>element===document.activeElement)){reached=true;break;}
      await page.keyboard.press('Tab');
    }
    assert.ok(reached,'Form submit must be reachable by keyboard Tab.');
    const focus=await submit().boundingBox();assert.ok(focus&&focus.x>=-1&&focus.x+focus.width<=391&&focus.y<844&&focus.y+focus.height>0,'Keyboard submit visible in mobile viewport.');
    await page.keyboard.press('Enter');await component.getByRole('alert').first().waitFor();
    assert.equal((await calls()).add.length,beforeMobile.add.length+1);assert.deepEqual((await calls()).add.at(-1),expectedPayload(mobileDraft,'USD'));
    assert.deepEqual(await snapshot(),mobileDraft,'Mobile error preserves long/huge draft.');assert.equal((await calls()).close,beforeMobile.close);
    await noOverflow();await page.screenshot({path:path.join(output,'addkasa258-mobile-error.png'),fullPage:false});
    assert.deepEqual(errors,[]);assert.deepEqual(blockedRequests,[]);
    checkpoints.push('390px full long names/options and huge numeric value; keyboard reaches/activates submit; error preserves draft; no document/body overflow or runtime errors');
    const result={status:'PASS',fixture,url,browser:browser.version(),node:process.version,platform:process.platform,arch:process.arch,viewports:['1440x1000','390x844'],fixedClock:fixedNow,
      browserPlugin:'Browser plugin not available',runtime:'Real AddKasaModal; conflicting EUR theme hook shim only; route-only synthetic document, no server/listening port/API/auth/real data.',checkpoints,mobileGeometry,errors,blockedRequests,expectedNativeWarnings,
      limitations:['Prepared component QA does not cover full App/HTTP/install/restore/pilot.','Invalid textual numbers are represented by changing only the real DOM input type to text; no React private internals are accessed.','Approval/payment authority, FX/currency support/exponents, idempotency and minor-unit arithmetic remain separate gates.']};
    fs.writeFileSync(path.join(output,'addkasa258-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }catch(error){
    if(page){await page.screenshot({path:path.join(output,'addkasa258-failure.png'),fullPage:false}).catch(()=>{});fs.writeFileSync(path.join(output,'addkasa258-failure.txt'),JSON.stringify({checkpoints,errors,blockedRequests,expectedNativeWarnings,message:error.message},null,2)+'\n'+await page.locator('body').innerText().catch(()=> 'No body'));}throw error;
  }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
