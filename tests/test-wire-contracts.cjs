const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const ts = require("typescript");
function load(file, extra = {}) {
 const box = { exports: {}, console, URL, Request, Response, TextEncoder, Uint8Array, Date, Error, ...extra };
 box.require = (p) => load(path.resolve(path.dirname(file), p) + ".ts", extra);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, box, {filename:file});
 return box.exports;
}
async function swop(){const out=[];for(const item of [
 {name:'health',path:'/health',method:'GET'},{name:'missing-client'},{name:'short-client',id:'1234567'},{name:'unlisted',id:'unlisted-device'},{name:'session-default'},{name:'session-malformed',body:'{'},{name:'session-null',body:'null'}, {name:'session-types',body:'{"caption":42,"draft":null}'},{name:'session-limits',body:JSON.stringify({caption:'é'.repeat(201),draft:'😀'.repeat(2001)})},...['0','-1','abc','0.1','60.9'].map(ttl=>({name:'ttl-'+ttl,ttl})),
 ...['{','null','{}','{"code":"x","value":""}','{"code":"x","value":" "}',JSON.stringify({code:'x',value:'😀'.repeat(4001)})].map((body,i)=>({name:'submit-'+i,path:'/submit',body})),
 ...['1234567','12345678','x'.repeat(128),'x'.repeat(129),'invalid!'].map((id,i)=>({name:'admin-'+i,path:'/admin/clients',body:JSON.stringify({clientId:id,note:' x '.repeat(100)})})),{name:'roundtrip',roundtrip:true},{name:'client-mismatch',roundtrip:true,mismatch:true}]){
 const values=new Map([['allow:device-123','{}'],['allow:other-123','{}']]),writes=[];const kv={async get(k){return values.get(k)??null},async put(k,v,opt){values.set(k,v);writes.push({key:k,value:JSON.parse(v),options:opt||null})},async delete(k){values.delete(k);writes.push({delete:k})},async list(){return{keys:Array.from(values.keys()).map(name=>({name}))}}};
 const worker=load(root+'/src/index.ts',{Date:{now:()=>1700000000000},crypto:{getRandomValues(b){b.fill(0);return b}}}).default;
 const env={SWOP:kv,PUBLIC_BASE_URL:'https://swop.example',ADMIN_TOKEN:'secret',SESSION_TTL_SECONDS:item.ttl};
 async function req(p='/session',method='POST',body='{}',id='device-123'){const headers={'Content-Type':'application/json',Authorization:'Bearer secret'};if(id!==null)headers['X-Swop-Client-Id']=id;const r=await worker.fetch(new Request('https://swop.example'+p,{method,headers,...(method==='GET'?{}:{body})}),env);return{status:r.status,body:await r.json()};}
 let responses=[];if(item.roundtrip){responses.push(await req());responses.push(await req('/val?c=aaaaaa','GET'));responses.push(await req('/submit','POST','{"code":" aaaaaa ","value":" v "}'));responses.push(await req('/submit','POST','{"code":"AAAAAA","value":"again"}'));responses.push(await req('/val?c=AAAAAA','GET','',item.mismatch?'other-123':'device-123'));responses.push(await req('/val?c=AAAAAA','GET'));}else responses.push(await req(item.path,item.method,item.body,item.name==='missing-client'?null:item.id));out.push({name:item.name,responses,writes});}return out;}
swop().then(actual => {
 const expected = JSON.parse(fs.readFileSync(path.join(__dirname,"fixtures/wire-contracts/before-js.json"))).swop;
 assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
 console.log("PASS 27 immutable SWOP HTTP/service wire contracts");
}).catch(error => { console.error(error); process.exitCode = 1; });
