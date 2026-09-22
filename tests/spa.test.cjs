const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const runtime = fs.readFileSync('apps-script/SpaRuntime.html', 'utf8').replace(/<\/?script>/g, '');
test('HtmlService inline scripts keep URLs out of backtick strings', () => {
  // Node/Chromium can parse these, but HtmlService can misread the URL's // as a comment.
  // Guard the source pattern too: the previous invite text passed JS syntax tests.
  for (const file of fs.readdirSync('apps-script').filter(file => file.endsWith('.html'))) {
    const html = fs.readFileSync('apps-script/' + file, 'utf8');
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      for (const literal of script[1].matchAll(/`(?:\\[\s\S]|[^`\\])*`/g)) {
        assert.ok(!/https?:\/\//.test(literal[0]), file + ': use quoted strings for inline URLs');
      }
    }
  }
});
const c = vm.createContext({ console });
vm.runInContext(runtime + '\nthis.Router=DietRouter;', c);
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise,resolve,reject }; };
const result = (view, value=1) => ({ view, data:{ valid:true, value } });
function setup(fetch) {
  const shown=[], errors=[], mounts=[], updates=[];
  const router=new c.Router({ fetch, loading() {}, show:view=>shown.push(view), error:e=>errors.push(e),
    mount:(view,data)=>{ mounts.push(view); return { update:data=>updates.push(data.value), dispose() {}, clearPrivate() {} }; } });
  return { router, shown, errors, mounts, updates };
}
test('rapid navigation deduplicates requests and last selection wins', async () => {
  const history=deferred(), personal=deferred(); let count=0;
  const { router,shown,mounts }=setup(view=>{ count++; return (view==='history'?history:personal).promise; });
  const a=router.go('history'), b=router.go('history'), d=router.go('personal');
  assert.equal(router.active,'form');
  history.resolve(result('history')); await Promise.all([a,b]);
  assert.deepEqual(shown,[]);
  personal.resolve(result('personal')); await d;
  for(let i=0;i<3;i++) for(const view of ['form','history','personal']) await router.go(view);
  assert.equal(count,2); assert.deepEqual(mounts,['history','personal']);
});
test('failed load leaves current view usable and can retry', async () => {
  let fails=true; const {router,errors}=setup(view=>fails?Promise.reject(new Error('offline')):Promise.resolve(result(view)));
  assert.equal(await router.go('wall'),false); assert.equal(router.active,'form');
  assert.equal(router.pending,''); assert.equal(errors.length,1);
  fails=false; assert.equal(await router.go('wall'),true); assert.equal(router.active,'wall');
});
test('save invalidation during a read discards stale response', async () => {
  const first=deferred(); let calls=0;
  const {router,updates,mounts}=setup(view=>++calls===1?first.promise:Promise.resolve(result(view,calls)));
  const work=router.go('history'); router.invalidate('history'); first.resolve(result('history',1)); await work;
  assert.equal(calls,2); assert.equal(router.state('history').applied,1); assert.equal(mounts.length,1);
  router.invalidate('history'); await router.state('history').request; assert.deepEqual(updates,[3]);
});
test('return to form cancels pending navigation without destroying downloaded component', async () => {
  const load=deferred(); const {router,shown}=setup(()=>load.promise);
  const pending=router.go('wall'); await router.go('form'); load.resolve(result('wall')); await pending;
  assert.equal(router.active,'form'); assert.deepEqual(shown,['form']);
  await router.go('wall'); assert.deepEqual(shown,['form','wall']);
});
test('dispose prevents late mount', async () => {
  const load=deferred(); const {router,mounts}=setup(()=>load.promise);
  const pending=router.go('history'); router.dispose(); load.resolve(result('history')); await pending;
  assert.deepEqual(mounts,[]);
});
test('component busy during a refresh stays stale until it can apply data', async () => {
  const {router}=setup(view=>Promise.resolve(result(view)));
  await router.go('wall');
  router.state('wall').instance.update=()=>false;
  router.invalidate('wall');await router.state('wall').request;
  assert.notEqual(router.state('wall').applied,router.state('wall').version);
  router.state('wall').instance.update=()=>true;
  await router.go('wall');
  assert.equal(router.state('wall').applied,router.state('wall').version);
});
test('all SPA data endpoints require form scope before reading data', () => {
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),context);
  let reads=0;
  context.inspectAccessToken_=(uid,sig,scope)=>{assert.equal(scope,'form');return sig==='form'?'ok':'invalid';};
  context.getPersonalSettingsData_=()=>{reads++;return {valid:true};};
  for(const view of ['history','personal','wall'])for(const sig of ['hub','wall','']) {
    assert.throws(()=>context.getSpaDataForClient({uid:'test',sig,view}));
  }
  assert.equal(reads,0);
  assert.equal(context.getSpaDataForClient({uid:'test',sig:'form',view:'personal'}).data.valid,true);
  assert.equal(reads,1);
});
test('server module bundle parses with original class selectors and no template fragments', () => {
  const context=vm.createContext({ HtmlService:{ createTemplateFromFile:file=>({getRawContent:()=>fs.readFileSync('apps-script/'+file+'.html','utf8')}) }, window:{} });
  vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),context);
  const source=context.getSpaModulesScript_();
  assert.equal((source.match(/<\/script>/g)||[]).length,1);
  vm.runInContext(source.slice(8,-9),context);
  for(const [key,module] of Object.entries(context.window.DietViewModules)) {
    assert.equal(typeof module.mount,'function'); assert.ok(module.markup.includes('id="'+module.dataId+'"'));
    assert.ok(!module.markup.includes('<?')); assert.ok(module.css.includes('.view-body {'));
  }
  assert.ok(context.window.DietViewModules.wall.css.includes('.person-body'));
});
