// Run with Playwright installed: node tests/spa.browser.cjs
// All RPC data is synthetic; no production account or records are accessed.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const backend=vm.createContext({HtmlService:{createTemplateFromFile:file=>({getRawContent:()=>fs.readFileSync('apps-script/'+file+'.html','utf8')})}});
vm.runInContext(fs.readFileSync('apps-script/Code.gs','utf8'),backend);
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const day=offset=>{const d=new Date(today+'T12:00:00+08:00');d.setDate(d.getDate()-offset);return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);};
const nav={formUrl:'http://spa.test/exec?uid=test&sig=test',historyUrl:'http://spa.test/exec?uid=test&sig=test&view=history',personalSettingsUrl:'http://spa.test/exec?uid=test&sig=test&view=personal',publicWallUrl:'http://spa.test/exec?uid=test&sig=test&view=wall'};
const member={name:'測試小雞',bmr:1500,publicAlias:'測試',defaultPublishToday:true,defaultPublishFoodDetails:true,defaultPublishToGroup:true,joinPublicRanking:true};
const profile={weightKg:65,proteinActivityLevel:'general',proteinTargetG:0};
const records=Array.from({length:45},(_,i)=>({date:day(i),intake:1200+i,tdee:1800,deficit:600-i,proteinG:70,exerciseMinutes:30,exerciseKcal:100,exerciseName:'快走',waterMl:1200,waterGoalMl:2000,waterTracked:true,status:'完成',meals:[{label:'早餐',names:['雞蛋'],kcal:200,proteinG:12}]}));
const history=()=>({valid:true,today,records,summary:{},session:{uid:'test',sig:'test'},nav,waterTrackingEnabled:true});
const personal=()=>({valid:true,auth:{uid:'test',sig:'test'},member:{...member},profile:{...profile},proteinTarget:{targetG:78,multiplier:1.2},reminders:{morning:true,noon:true,evening:true},groupWalls:[],checkInSpaces:[],nav});
const wall=date=>({date:date||today,today,minDate:day(29),maxDate:today,generatedAt:'test',viewer:{uid:'test',sig:'hub',canLike:true},summary:{publicCount:1,completedCount:1,rankingCount:1},records:[{userId:'friend',alias:'測試小雞',intake:1200,tdee:1800,proteinG:70,isComplete:true,isSelf:false,likeKey:'test-like',likeCount:0,meals:[]}],ranking:[],streaks:[],groupTabs:[{groupId:'g1',groupName:'測試群組',name:'測試群組'}],nav});
const bootstrap={valid:true,uid:'test',sig:'test',today,initialDate:today,initialView:'form',member,foods:[],frequentFoods:[],waterSettings:{enabled:true,goalMl:2000},personalProfile:profile,proteinTarget:{targetG:78},newFeatureNotice:{show:false},dailyLogs:{},recordDates:[0,1,2,3].map(i=>({date:day(i),label:day(i)})),checkInSpaces:[],...nav};
const esc=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function html(initial='form') {
  const boot={...bootstrap,initialView:initial};
  if(initial!=='form')boot.initialSubview={view:initial,data:initial==='history'?history():initial==='personal'?personal():wall()};
  return fs.readFileSync('apps-script/Index.html','utf8')
    .replace('<?= initialSubviewClass ?>',initial==='form'?'':'spa-initial-subview')
    .replace('<?= bootstrapJson ?>',()=>esc(JSON.stringify(boot)))
    .replace("<?!= HtmlService.createHtmlOutputFromFile('SpaRuntime').getContent() ?>",()=>fs.readFileSync('apps-script/SpaRuntime.html','utf8'))
    .replace('<?!= getSpaModulesScript_() ?>',()=>backend.getSpaModulesScript_());
}
(async()=>{
  const browser=await chromium.launch({headless:true, ...(process.env.SPA_BROWSER_CHANNEL ? {channel:process.env.SPA_BROWSER_CHANNEL} : {})});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const errors=[], calls=[];
    let failView='', delay=20, holdPersonalRead=false, heldPersonalRead=null;
    let holdPublicRead=false, heldPublicRead=null, hideGroups=false, groupReads=0;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',dialog=>dialog.accept());
    await page.exposeFunction('mockRpc',async(method,args)=>{
      calls.push({method,args}); await new Promise(r=>setTimeout(r,delay));
      const p=args[0]||{};
      if(method==='getSpaDataForClient') {
        if(failView===p.view)throw new Error('測試連線中斷');
        if(p.view==='personal' && holdPersonalRead) {
          holdPersonalRead=false;
          const stale=personal();
          return new Promise(resolve=>{heldPersonalRead=()=>resolve({view:'personal',data:stale});});
        }
        const data=p.view==='history'?history():p.view==='personal'?personal():wall(p.date);
        if(p.view==='wall'&&hideGroups)data.groupTabs=[];
        return {view:p.view,data};
      }
      if(method==='savePersonalSettingsForClient') { Object.assign(member,p.member);Object.assign(profile,p.profile);return personal(); }
      if(method==='saveDailyLog')return {isComplete:p.isComplete,totalIntake:1200,hasBmr:true,estimatedDeficit:600};
      if(method==='getGroupWallDataForClient')return {date:args[3],generatedAt:'group-'+(++groupReads),group:{groupId:'g1',name:'測試群組'},summary:{sharedCount:1,completedCount:1,memberCount:2},records:wall().records};
      if(method==='getPublicWallDataForClient') {
        const data=wall(args[2]);
        if(holdPublicRead) {holdPublicRead=false;return new Promise(resolve=>{heldPublicRead=()=>resolve(data);});}
        return data;
      }
      if(method==='getDailyFormForDate')return {date:p.recordDate,log:null};
      if(method==='getHistoryCopyDraftForClient')return {targetDate:today,sourceDate:p.sourceDate,meals:{},aiMeals:{breakfast:[{name:'複製雞蛋',calories:80,proteinG:6}]}};
      if(method==='analyzeFoodPhoto')return {items:[{name:'辨識雞蛋',estimatedAmount:100,estimatedCalories:160,estimatedProteinG:12}]};
      if(/like/i.test(method))return {likeCount:1,liked:true};
      throw new Error('Unmocked RPC '+method);
    });
    await page.addInitScript(()=>{
      function run(ok=()=>{},bad=()=>{}) {return new Proxy({}, {get(_,key){
        if(key==='withSuccessHandler')return fn=>run(fn,bad);
        if(key==='withFailureHandler')return fn=>run(ok,fn);
        return (...args)=>window.mockRpc(key,args).then(ok,bad);
      }});}
      window.google={script:{run:run()}};
    });
    await page.route('http://spa.test/**',route=>route.fulfill({contentType:'text/html',body:html(new URL(route.request().url()).searchParams.get('entry')||'form')}));
    await page.goto('http://spa.test/exec');
    await page.waitForFunction(()=>window.__dietAppReady);
    assert.equal(await page.locator('iframe').count(),0);
    const go=async view=>{
      await page.evaluate(()=>{if(document.activeElement)document.activeElement.blur();});
      await page.locator('#bottomNav [data-spa-view="'+view+'"]').click();
      try {await page.waitForFunction(v=>document.querySelector('#bottomNav [data-spa-view="'+v+'"]').classList.contains('active'),view,{timeout:5000});}
      catch(error){console.error('View failed',view,await page.locator('body > #toast').textContent(),errors);throw error;}
    };
    // The form DOM remains alive, including text not yet committed as a meal.
    console.log('Mounted form');
    await page.locator('#mealTabs button').first().click();
    await page.locator('#manualModeButton').click();
    const textField=page.locator('#customFoodName');
    await textField.fill('保留尚未送出的文字');
    const retainedId=await textField.getAttribute('id');
    await go('history');
    await page.locator('#view-history [data-history-range="custom"]').click();
    await page.locator('#view-history [data-history-view="calendar"]').click();
    await page.evaluate(()=>window.scrollTo(0,250));
    const scroll=await page.evaluate(()=>window.scrollY);
    await go('personal');
    await page.locator('#view-personal #name').fill('未儲存設定');
    await go('wall');
    await page.locator('#view-wall #publicDateSelect').selectOption(day(1));
    await page.waitForTimeout(80);
    await go('form');
    assert.equal(await page.locator('#app #'+retainedId).inputValue(),'保留尚未送出的文字');
    await go('history');
    assert.ok(await page.locator('#view-history [data-history-view="calendar"]').evaluate(el=>el.classList.contains('active')||el.getAttribute('aria-selected')==='true'));
    assert.ok(Math.abs(await page.evaluate(()=>window.scrollY)-scroll)<2);
    await go('personal');assert.equal(await page.locator('#view-personal #name').inputValue(),'未儲存設定');
    await go('wall');assert.equal(await page.locator('#view-wall #publicDateSelect').inputValue(),day(1));
    for(let i=0;i<3;i++)for(const view of ['history','personal','wall','form'])await go(view);
    assert.equal(calls.filter(c=>c.method==='getSpaDataForClient').length,3,'cached views do not refetch');
    await page.screenshot({path:'/tmp/calorie-spa-form.png',fullPage:false});
    await go('history');await page.screenshot({path:'/tmp/calorie-spa-history.png',fullPage:false});
    // Real canvas export and report state survive navigation.
    await page.locator('#view-history [data-week-report]').first().click();
    await page.locator('#view-history #hideCaloriesInWeeklyShare').check();
    await go('wall');await go('history');
    assert.ok(await page.locator('#view-history #hideCaloriesInWeeklyShare').isChecked());
    const weeklyDownload=page.waitForEvent('download');
    await page.locator('#view-history [data-week-report-download]').click();
    assert.ok((await weeklyDownload).suggestedFilename().endsWith('.png'));
    await page.locator('#view-history [data-week-report-back]').click();
    await page.locator('#view-history [data-month-report]').first().click();
    const monthlyDownload=page.waitForEvent('download');
    await page.locator('#view-history [data-report-download]').click();
    assert.ok((await monthlyDownload).suggestedFilename().endsWith('.png'));
    await page.locator('#view-history [data-report-back]').click();
    // Settings updates the hidden form without deleting unfinished manual input.
    await go('personal');
    await page.locator('#view-personal #bmr').fill('1700');
    await page.locator('#view-personal [name="proteinActivity"][value="strength"]').check();
    await page.locator('#view-personal #saveSettings').click();
    await page.waitForFunction(()=>document.querySelector('#app #bmr').value==='1700');
    await go('form');
    assert.equal(await page.locator('#customFoodName').inputValue(),'保留尚未送出的文字');
    await page.locator('#customFoodKcal').fill('300');
    await page.locator('#addCustomFoodButton').click();
    await go('history');
    await page.waitForTimeout(1400);
    assert.ok(calls.some(c=>c.method==='saveDailyLog'&&c.args[0].bmr===1700));
    // A delayed pre-write settings read cannot revert a successful save.
    await go('personal');
    holdPersonalRead=true;
    await page.evaluate(()=>appRouter.invalidate('personal'));
    while(!heldPersonalRead)await new Promise(resolve=>setTimeout(resolve,10));
    await page.locator('#view-personal #bmr').fill('1750');
    await page.locator('#view-personal #spaceName').fill('尚未建立的空間');
    await page.locator('#view-personal #saveSettings').click();
    await page.waitForFunction(()=>document.querySelector('#app #bmr').value==='1750');
    heldPersonalRead();
    await page.waitForFunction(()=>!appRouter.state('personal').request);
    assert.equal(await page.locator('#view-personal #bmr').inputValue(),'1750');
    assert.equal(await page.locator('#view-personal #spaceName').inputValue(),'尚未建立的空間');
    // Group wall and optimistic like remain usable after returning from another tab.
    await go('wall');
    await page.locator('#view-wall [data-wall-tab="group:g1"]').click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('#wallTitle').textContent.includes('測試群組'));
    await go('personal');await go('wall');
    assert.ok((await page.locator('#view-wall #wallTitle').textContent()).includes('測試群組'));
    await page.locator('#view-wall #groupRecordsPanel .person > summary').first().click();
    const expectedGroupRead=groupReads+1;
    await page.evaluate(()=>appRouter.invalidate('wall'));
    await page.waitForFunction(n=>document.querySelector('#view-wall').shadowRoot.querySelector('#updated').textContent.includes('group-'+n),expectedGroupRead);
    assert.ok(await page.locator('#view-wall #groupRecordsPanel .person').first().evaluate(node=>node.open));
    await page.locator('#view-wall #publicDateSelect').selectOption(day(2));
    await page.waitForFunction(date=>document.querySelector('#view-wall').shadowRoot.querySelector('#heroDate').textContent.includes(date.slice(5).replace('-','/')),day(2));
    const wallReads=calls.filter(c=>c.method==='getPublicWallDataForClient').length;
    await page.locator('#view-wall [data-wall-tab="public"]').click();
    await page.waitForFunction(date=>{
      const root=document.querySelector('#view-wall').shadowRoot;
      return !root.querySelector('#publicDateSelect').disabled
        && root.querySelector('#wallTitle').textContent.includes('猛猛紀錄牆')
        && root.querySelector('#publicCountLabel').textContent.startsWith(date.slice(5).replace('-','/'));
    },day(2));
    assert.equal(calls.filter(c=>c.method==='getPublicWallDataForClient').length,wallReads+1);
    // A pre-permission-change date response must not restore cleared group data or dates.
    holdPublicRead=true;
    await page.locator('#view-wall #publicDateSelect').selectOption(day(3));
    while(!heldPublicRead)await new Promise(resolve=>setTimeout(resolve,10));
    hideGroups=true;
    await page.evaluate(()=>appRouter.invalidate('wall',{clear:true}));
    await page.waitForFunction(()=>!appRouter.state('wall').request);
    heldPublicRead();await page.waitForTimeout(80);
    assert.equal(await page.locator('#view-wall [data-wall-tab="group:g1"]').count(),0);
    assert.equal(await page.locator('#view-wall #publicDateSelect').inputValue(),day(2));
    await page.locator('#view-wall [data-like-key="test-like"]').click();
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#view-wall .like-count').first().textContent(),'1');
    // Photo analysis can finish while another view is visible; preview/review survive.
    await go('form');
    const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=20;return c.toDataURL('image/png').split(',')[1];});
    await page.locator('#foodPhotoUpload').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await go('personal');await page.waitForTimeout(150);await go('form');
    assert.ok((await page.locator('#photoPreview').getAttribute('src')).startsWith('data:image/'));
    await page.waitForFunction(()=>document.querySelector('#aiResult .ai-review-grid input')?.value==='辨識雞蛋');
    // Backfill uses the same form, and copy creates an explicit recovery choice.
    await go('history');
    await page.locator('#view-history [data-history-view="list"]').click();
    await page.locator('#view-history #history-record-'+day(1)+' > summary').click();
    await page.locator('#view-history [data-spa-backfill="'+day(1)+'"]').click();
    await page.waitForFunction(date=>document.querySelector('#app .hero-title-wrap > p').textContent.includes(date),day(1));
    await go('history');
    await page.locator('#view-history #history-record-'+day(4)+' > summary').click();
    await page.locator('#view-history [data-copy-date="'+day(4)+'"]').click();
    await page.waitForFunction(()=>!!document.querySelector('#localDraftRecovery'));
    assert.ok((await page.locator('#localDraftRecovery').textContent()).includes('還原草稿'));
    // Browser back returns to prior tab without a document reload.
    await go('personal');await go('wall');await page.goBack();
    await page.waitForFunction(()=>document.querySelector('#bottomNav [data-spa-view="personal"]').classList.contains('active'));
    console.log('Passed reports, settings synchronization, auto-save, group wall, likes, photos, backfill/copy and browser back');
    // Cold-load failure leaves form and supports retry.
    failView='history';await page.goto('http://spa.test/exec');await page.waitForFunction(()=>window.__dietAppReady);
    await page.locator('#bottomNav [data-spa-view="history"]').click();await page.waitForTimeout(150);
    assert.ok(await page.locator('#bottomNav [data-spa-view="form"]').evaluate(el=>el.classList.contains('active')));
    failView='';await go('history');
    // Deep links mount their prepared destination without a JSON fetch or form flash.
    for(const view of ['history','personal','wall']) {
      const before=calls.filter(c=>c.method==='getSpaDataForClient').length;
      await page.goto('http://spa.test/exec?entry='+view);
      await page.waitForFunction(v=>document.querySelector('#bottomNav [data-spa-view="'+v+'"]').classList.contains('active'),view);
      assert.equal(calls.filter(c=>c.method==='getSpaDataForClient').length,before);
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: four views, repeated navigation, draft fields, filters/calendar/scroll, wall date, failure retry, prepared deep links, no iframe or JS errors.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
