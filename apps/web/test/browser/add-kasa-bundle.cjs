const fs=require('fs'),path=require('path'),{createRequire}=require('module');
async function build(fixture,output){
  fixture=path.resolve(fixture); output=path.resolve(output);
  const web=path.join(fixture,'apps/web');
  const req=createRequire(path.join(web,'package.json')),esbuild=createRequire(req.resolve('vite'))('esbuild');
  const result=await esbuild.build({absWorkingDir:web,
    stdin:{contents:fs.readFileSync(path.join(__dirname,'add-kasa-entry.tsx'),'utf8'),resolveDir:web,loader:'tsx'},
    bundle:true,write:false,metafile:true,outfile:path.join(output,'add-kasa-bundle.js'),platform:'browser',format:'iife',jsx:'automatic',
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},
    plugins:[{name:'addkasa258-theme-only',setup(build){
      build.onResolve({filter:/(?:^|\/)context\/ThemeContext(?:\.js|\.tsx)?$/},()=>({path:'addkasa258-theme',namespace:'addkasa258-theme'}));
      build.onLoad({filter:/.*/,namespace:'addkasa258-theme'},()=>({contents:'export const useTheme=()=>({settings:{primaryColor:"#2563eb",baseCurrency:"EUR"}});',loader:'js'}));
    }}],logLevel:'silent'});
  const inputs=Object.keys(result.metafile.inputs).map(name=>name.replaceAll('\\','/'));
  if(!inputs.some(name=>name.endsWith('/components/AddKasaModal.tsx')))throw new Error('Real AddKasaModal absent from bundle.');
  if(inputs.some(name=>/(?:^|\/)(?:api|auth)(?:\/|\.[jt]sx?$)/i.test(name)))throw new Error('Unexpected API/auth runtime dependency.');
  for(const file of result.outputFiles)fs.writeFileSync(file.path,file.contents);
  console.log(JSON.stringify({status:'BUILT',fixture,componentInputs:inputs.filter(name=>name.endsWith('/components/AddKasaModal.tsx')),themeShim:'primaryColor plus deliberately conflicting EUR base',browserRun:false}));
}
module.exports={build};
