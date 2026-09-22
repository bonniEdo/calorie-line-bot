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
let spaces=[], includeLegacyGroup=true;
const spaceTabs=()=>spaces.map(space=>({groupId:space.groupId,name:space.name,type:'space'}));
const joinedGroups=()=>[...(includeLegacyGroup?[{groupId:'g1',name:'測試群組',type:'line_group'}]:[]),...spaceTabs()];
const profile={weightKg:65,proteinActivityLevel:'general',proteinTargetG:0};
const records=Array.from({length:45},(_,i)=>({date:day(i),intake:1200+i,tdee:1800,deficit:600-i,proteinG:70,exerciseMinutes:30,exerciseKcal:100,exerciseName:'快走',waterMl:1200,waterGoalMl:2000,waterTracked:true,status:'完成',meals:[{label:'早餐',names:['雞蛋'],kcal:200,proteinG:12}]}));
const history=()=>({valid:true,today,records,summary:{},session:{uid:'test',sig:'test'},nav,waterTrackingEnabled:true});
const personal=()=>({valid:true,auth:{uid:'test',sig:'test'},member:{...member},profile:{...profile},proteinTarget:{targetG:78,multiplier:1.2},reminders:{morning:true,noon:true,evening:true},groupWalls:joinedGroups(),checkInSpaces:structuredClone(spaces),groupSharing:member.defaultPublishToGroup,nav});
const wall=date=>({date:date||today,today,minDate:day(29),maxDate:today,generatedAt:'test',viewer:{uid:'test',sig:'hub',canLike:true},summary:{publicCount:1,completedCount:1,rankingCount:1},records:[{userId:'friend',alias:'測試小雞',intake:1200,tdee:1800,proteinG:70,isComplete:true,isSelf:false,likeKey:'test-like',likeCount:0,meals:[]}],ranking:[],streaks:[{alias:'連續零天測試',streak:0,isSelf:false,completedOnDate:false,likeKey:'test-like',likeCount:0}],groupTabs:joinedGroups(),checkInSpaces:structuredClone(spaces),groupSharing:member.defaultPublishToGroup,nav});
const bootstrap={valid:true,uid:'test',sig:'test',today,initialDate:today,initialView:'form',member,foods:[],frequentFoods:[],waterSettings:{enabled:true,goalMl:2000},personalProfile:profile,proteinTarget:{targetG:78},dailyLogs:{},recordDates:[0,1,2,3].map(i=>({date:day(i),label:day(i)})),checkInSpaces:[],...nav};
const esc=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function html(initial='form', fault='') {
  const boot={...bootstrap,groupWalls:joinedGroups(),checkInSpaces:structuredClone(spaces),initialView:initial};
  if(initial!=='form')boot.initialSubview={view:initial,data:initial==='history'?history():initial==='personal'?personal():wall()};
  const runtime=fault==='syntax' ? '<script>function brokenRuntime(</script>'
    : fault==='missing-runtime' ? '' : fs.readFileSync('apps-script/SpaRuntime.html','utf8');
  return fs.readFileSync('apps-script/Index.html','utf8')
    .replace('<?= initialSubviewClass ?>',initial==='form'?'':'spa-initial-subview')
    .replace('<?= bootstrapJson ?>',()=>esc(JSON.stringify(boot)))
    .replace("<?!= HtmlService.createHtmlOutputFromFile('SpaRuntime').getContent() ?>",()=>runtime)
    .replace('<?!= getSpaModulesScript_() ?>',()=>fault==='missing-modules'?'':backend.getSpaModulesScript_());
}
(async()=>{
  const browser=await chromium.launch({headless:true, ...(process.env.SPA_BROWSER_CHANNEL ? {channel:process.env.SPA_BROWSER_CHANNEL} : {})});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    page.setDefaultTimeout(10000);
    const errors=[], calls=[];
    let failView='', delay=20, holdPersonalRead=false, heldPersonalRead=null;
    let holdPublicRead=false, heldPublicRead=null, hideGroups=false, groupReads=0;
    let holdPhoto=false, heldPhoto=null, failPhoto=false, emptyPhoto=false;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',dialog=>dialog.accept());
    await page.exposeFunction('mockRpc',async(method,args)=>{
      calls.push({method,args,at:Date.now()}); await new Promise(r=>setTimeout(r,delay));
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
      if(method==='createCheckInSpaceForClient') {
        const created={groupId:'space_'+(spaces.length+1),name:p.name,isOwner:true,memberCount:1,inviteCode:'MMABC123',inviteExpiresAt:'2026-10-01 18:00',inviteActive:true};
        spaces.push(created);member.defaultPublishToGroup=true;return {ok:true,created,spaces:structuredClone(spaces),groupWalls:joinedGroups(),groupSharing:true};
      }
      if(method==='joinCheckInSpaceForClient') {
        if(p.inviteCode==='EXPIRED')throw new Error('這組邀請碼已過期，請向空間擁有者索取新的邀請碼。');
        let joined=spaces.find(space=>space.groupId==='space_friend');
        if(joined)return {ok:true,joined:{...joined,alreadyJoined:true},spaces:structuredClone(spaces),groupWalls:joinedGroups(),groupSharing:member.defaultPublishToGroup};
        joined={groupId:'space_friend',name:'朋友的打卡空間',isOwner:false,memberCount:2,inviteCode:'',inviteExpiresAt:'',inviteActive:false};
        spaces.push(joined);member.defaultPublishToGroup=true;return {ok:true,joined,spaces:structuredClone(spaces),groupWalls:joinedGroups(),groupSharing:true};
      }
      if(method==='savePersonalSettingsForClient') { Object.assign(member,p.member);Object.assign(profile,p.profile);return personal(); }
      if(method==='saveDailyLog'){member.defaultPublishToGroup=p.publishToGroup;return {isComplete:p.isComplete,totalIntake:1200,hasBmr:true,estimatedDeficit:600,defaultPublishToGroup:p.publishToGroup};}
      if(method==='getGroupWallDataForClient')return {date:args[3],generatedAt:'group-'+(++groupReads),group:{groupId:args[2],name:spaces.find(space=>space.groupId===args[2])?.name||'測試群組',type:args[2]==='g1'?'line_group':'space'},summary:{sharedCount:1,completedCount:1,memberCount:2},records:wall().records};
      if(method==='getPublicWallDataForClient') {
        const data=wall(args[2]);
        if(holdPublicRead) {holdPublicRead=false;return new Promise(resolve=>{heldPublicRead=()=>resolve(data);});}
        return data;
      }
      if(method==='getDailyFormForDate')return {date:p.recordDate,log:null};
      if(method==='getHistoryCopyDraftForClient')return {targetDate:today,sourceDate:p.sourceDate,meals:{},aiMeals:{breakfast:[{name:'複製雞蛋',calories:80,proteinG:6}]}};
      if(method==='analyzeFoodPhoto') {
        if(failPhoto) {failPhoto=false;throw new Error('測試 AI 暫時忙碌');}
        const result={items:emptyPhoto?[]:[{name:'辨識雞蛋',portion:'一份',estimatedAmount:100,unit:'g',estimatedCalories:160,estimatedProteinG:12,caloriesLow:140,caloriesHigh:180,confidence:'中',notes:'油量不確定'}],timing:{prepareMs:5,quotaMs:2,aiMs:30,retryWaitMs:0,totalMs:35,attempts:[{model:'gemini-3.5-flash-lite',status:200,durationMs:30,outcome:'success'}],outcome:'success',phase:'normalize'}};
        emptyPhoto=false;
        if(holdPhoto) {holdPhoto=false;return new Promise(resolve=>{heldPhoto=()=>resolve(result);});}
        return result;
      }
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
      window.photoTimings=[];
      const originalInfo=console.info;
      console.info=(...args)=>{if(args[0]==='photo_analysis')window.photoTimings.push(args[1]);originalInfo.apply(console,args);};
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
    const openFriendMenu=async card=>{
      const menu=card.locator('.friends-more');
      if(!await menu.evaluate(node=>node.open)) await menu.locator(':scope > summary').click();
    };
    // The form DOM remains alive, including text not yet committed as a meal.
    console.log('Mounted form');
    assert.equal(await page.locator('#joinPublicRanking').evaluate(node=>getComputedStyle(node.closest('label')).display),'none');
    assert.equal(await page.locator('#joinPublicRanking').isChecked(),true,'existing ranking preference is preserved while its control is hidden');
    assert.ok(!(await page.locator('#publicSettingsStatus').textContent()).includes('排行'));

    await page.locator('#mealTabs button').first().click();
    await page.locator('#manualModeButton').click();
    await page.waitForFunction(()=>document.activeElement?.id==='customFoodKcal');
    const textField=page.locator('#customFoodName');
    await textField.fill('保留尚未送出的文字');
    assert.equal(await textField.inputValue(),'保留尚未送出的文字');
    const retainedId=await textField.getAttribute('id');
    await go('history');
    await page.locator('#view-history [data-history-range="custom"]').click();
    await page.locator('#view-history [data-history-view="calendar"]').click();
    await page.evaluate(()=>window.scrollTo(0,250));
    const scroll=await page.evaluate(()=>window.scrollY);
    await go('personal');
    assert.equal(await page.locator('#view-personal #joinPublicRanking').isVisible(),false);
    assert.equal(await page.locator('#view-personal #joinPublicRanking').isChecked(),true);
    await page.locator('#view-personal #name').fill('未儲存設定');
    await go('wall');
    assert.equal(await page.locator('#view-wall .summary-card:visible').count(),2,'public wall shows records and completion only');
    const publicWallText=await page.locator('#view-wall #publicWallContent').innerText();
    assert.ok(publicWallText.includes('測試小雞'),'public records remain visible');
    assert.ok(!publicWallText.includes('連續紀錄'));
    assert.ok(!publicWallText.includes('連續零天測試'),'zero-day streak data is not rendered');
    assert.equal(await page.locator('#view-wall #recordsPanel').isVisible(),true);
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:'/tmp/calorie-wall-records-only.png'});
    const lineCard=page.locator('#view-wall [data-friend-type="line_group"]');
    assert.equal(await lineCard.count(),1);
    assert.equal(await page.locator('#view-wall #friendsIntro').evaluate(node=>node.open),false,'joined users start with introduction collapsed');
    assert.equal(await page.locator('#view-wall #friendsCreateToggle').isVisible(),false);
    await page.locator('#view-wall #friendSpaces').screenshot({path:'/tmp/calorie-friends-existing-user.png',style:'#bottomNav {visibility:hidden !important}'});
    assert.equal(await lineCard.locator('[data-friend-invite]').count(),0);
    assert.equal(await page.locator('#view-wall [data-wall-tab="group:g1"] .friends-type').textContent(),'LINE 群組');
    assert.equal(await lineCard.locator('.friends-more').evaluate(node=>node.open),false);
    await lineCard.locator('.friends-more > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await lineCard.locator('[data-friend-line-guide]').isVisible(),true,'more actions are accessible by keyboard');
    assert.equal(await page.locator('#view-wall [data-wall-tab="public"]').evaluate(node=>node.classList.contains('active')),true,'opening more options does not change the selected wall');
    await lineCard.locator('[data-friend-line-guide]').click();
    assert.equal(await page.locator('#view-wall #friendsIntro').evaluate(node=>node.open),true,'invitation help opens its collapsed parent');
    assert.equal(await page.locator('#view-wall #friendsLineGuide').evaluate(node=>node.open),true);
    assert.ok((await page.locator('#view-wall #friendsLineGuide').textContent()).includes('啟用排行'));
    await go('form');await go('wall');
    assert.equal(await page.locator('#view-wall #friendsLineGuide').evaluate(node=>node.open),true,'guide stays open after returning');
    await page.locator('#view-wall #friendsLineGuide > summary').click();
    await page.locator('#view-wall #friendsIntro > summary').click();
    await go('form');await go('wall');
    assert.equal(await page.locator('#view-wall #friendsIntro').evaluate(node=>node.open),false,'manual collapse survives navigation');
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
    assert.equal(calls.filter(c=>c.method==='getSpaDataForClient').length,3,'cached views do not refetch: '+JSON.stringify(calls.map(c=>({method:c.method,view:c.args[0]?.view,at:c.at-calls[0].at}))));
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
    assert.equal(calls.filter(c=>c.method==='savePersonalSettingsForClient').at(-1).args[0].member.joinPublicRanking,true,'saving settings keeps the hidden participation preference');
    assert.equal(calls.filter(c=>c.method==='saveDailyLog').at(-1).args[0].joinPublicRanking,true,'daily autosave keeps the hidden participation preference');
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
    assert.equal(await page.locator('#view-wall .summary-card:visible').count(),3,'group member count remains available');
    assert.equal(await page.locator('#view-wall #groupMemberCount').textContent(),'2');
    assert.equal(await page.locator('#view-wall #groupMemberCountLabel').textContent(),'群組成員');
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
    assert.equal(await page.locator('#view-wall .summary-card:visible').count(),2,'returning from a group restores the two-card public summary');
    assert.equal(await page.locator('#view-wall #groupMemberCountCard').isVisible(),false);
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
    const uploadPhoto=()=>page.locator('#foodPhotoUpload').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    const waitForPhoto=async()=>{
      for(let i=0;i<200&&!heldPhoto;i++)await new Promise(resolve=>setTimeout(resolve,10));
      assert.ok(heldPhoto,'photo RPC should be pending');
    };
    holdPhoto=true;
    const beforePhotos=calls.filter(call=>call.method==='analyzeFoodPhoto').length;
    await uploadPhoto();await waitForPhoto();
    await uploadPhoto();
    assert.equal(calls.filter(call=>call.method==='analyzeFoodPhoto').length,beforePhotos+1,'duplicate uploads while analyzing do not send duplicate requests');
    await go('personal');await page.waitForTimeout(150);await go('form');
    assert.ok((await page.locator('#photoPreview').getAttribute('src')).startsWith('data:image/'));
    assert.equal(await page.locator('#aiStatus').textContent(),'正在辨識餐點…');
    heldPhoto();heldPhoto=null;
    await page.waitForFunction(()=>document.querySelector('#aiResult .ai-review-grid input')?.value==='辨識雞蛋');
    assert.equal(await page.evaluate(()=>state.aiWaitTimer),null);
    await page.locator('#aiResult .ai-details > summary').click();
    const reviewRow=page.locator('#aiResult .ai-review-row').first();
    await reviewRow.locator('.portion-editor input').fill('200');
    assert.equal(await reviewRow.locator('.ai-review-grid input[type="number"]').inputValue(),'320');
    await reviewRow.locator('.ai-review-grid input[type="number"]').fill('350');
    await reviewRow.locator('.portion-editor input').fill('300');
    assert.equal(await reviewRow.locator('.ai-review-grid input[type="number"]').inputValue(),'525');
    assert.ok((await reviewRow.locator('.ai-meta').textContent()).includes('300 g'));
    assert.ok((await reviewRow.locator('.ai-meta').textContent()).includes('36'));
    await page.locator('#confirmAiButton').click();
    await page.waitForFunction(()=>state.aiMeals[state.activeMeal].some(item=>item.name==='辨識雞蛋'));
    const savedPhoto=page.locator('#selectedList .selected-ai-row').filter({hasText:'辨識雞蛋'});
    await savedPhoto.locator('.selected-ai-details > summary').click();
    await savedPhoto.locator('.ai-kcal').fill('450');
    await savedPhoto.locator('.portion-editor input').fill('100');
    assert.equal(await savedPhoto.locator('.ai-kcal').inputValue(),'150','saved items retain manual calorie correction after portion changes');
    assert.ok((await savedPhoto.locator('.protein-chip').textContent()).includes('12 g'),'protein badge follows the changed portion');
    await page.waitForFunction(()=>!state.saveInFlight && state.savedMealRevision===state.mealRevision);
    const photoTiming=await page.evaluate(()=>window.photoTimings.at(-1));
    assert.equal(photoTiming.outcome,'success');assert.equal(photoTiming.server.aiMs,30);
    assert.ok(photoTiming.prepareMs>=0 && photoTiming.roundTripMs>=0 && photoTiming.totalMs>=photoTiming.roundTripMs);
    assert.ok(photoTiming.inputBytes>0 && photoTiming.imageBytes>0);
    for(const value of ['test.png','辨識雞蛋','uid','sig','base64'])assert.ok(!JSON.stringify(photoTiming).includes(value));
    failPhoto=true;await uploadPhoto();
    await page.waitForFunction(()=>!state.analyzing && document.getElementById('aiStatus').textContent.includes('辨識未完成'));
    assert.equal(await page.evaluate(()=>state.aiWaitTimer),null);
    assert.equal(await page.evaluate(()=>window.photoTimings.at(-1).outcome),'failed');
    const beforeBadImage=calls.filter(call=>call.method==='analyzeFoodPhoto').length;
    await page.locator('#foodPhotoUpload').setInputFiles({name:'bad.png',mimeType:'image/png',buffer:Buffer.from('invalid image')});
    await page.waitForFunction(()=>!state.analyzing && document.getElementById('aiStatus').textContent.includes('照片處理失敗'));
    assert.equal(calls.filter(call=>call.method==='analyzeFoodPhoto').length,beforeBadImage);
    assert.equal(await page.evaluate(()=>state.aiWaitTimer),null);
    assert.equal(await page.evaluate(()=>window.photoTimings.at(-1).outcome),'prepare_failed');
    emptyPhoto=true;await uploadPhoto();
    await page.waitForFunction(()=>!state.analyzing && document.getElementById('aiStatus').textContent.includes('沒有辨識到食物'));
    assert.equal(await page.evaluate(()=>state.pendingAiItems.length),0);
    assert.equal(await page.evaluate(()=>state.aiWaitTimer),null);
    // A response from a previous date must not replace the new date's form or wait message.
    holdPhoto=true;await uploadPhoto();await waitForPhoto();
    // Backfill uses the same form, and copy creates an explicit recovery choice.
    await go('history');
    await page.locator('#view-history [data-history-view="list"]').click();
    await page.locator('#view-history #history-record-'+day(1)+' > summary').click();
    await page.locator('#view-history [data-spa-backfill="'+day(1)+'"]').click();
    await page.waitForFunction(date=>document.querySelector('#app .hero-title-wrap > p').textContent.includes(date),day(1));
    heldPhoto();heldPhoto=null;
    await page.waitForFunction(()=>window.photoTimings.at(-1).outcome==='discarded');
    assert.equal(await page.evaluate(()=>state.pendingAiItems.length),0);
    assert.equal(await page.evaluate(()=>state.aiWaitTimer),null);
    assert.equal(await page.locator('#aiStatus').textContent(),'');
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
    // Friend entry, owner invitation, failed joins, duplicate joins and draft retention.
    hideGroups=false;spaces=[];includeLegacyGroup=false;member.defaultPublishToGroup=false;
    await page.evaluate(()=>localStorage.clear());
    const addTestMeal=async()=>{
      await page.locator('#mealTabs button').first().click();
      await page.locator('#manualModeButton').click();
      await page.waitForFunction(()=>document.activeElement?.id==='customFoodKcal');
      await page.locator('#customFoodName').fill('測試早餐');
      await page.locator('#customFoodKcal').fill('300');
      await page.locator('#addCustomFoodButton').click();
      await page.waitForFunction(()=>!state.saveInFlight && state.savedMealRevision===state.mealRevision);
    };
    await page.goto('http://spa.test/exec');await page.waitForFunction(()=>window.__dietAppReady);
    await addTestMeal();
    await page.locator('#submitButton').click();
    await page.waitForFunction(()=>!document.getElementById('friendFollowup').hidden);
    assert.ok((await page.locator('#friendFollowup').textContent()).includes('找個朋友一起記錄'));
    await page.locator('#friendFollowup .friend-close').click();
    await page.evaluate(()=>showFriendFollowup_());
    assert.ok(await page.locator('#friendFollowup').evaluate(node=>node.hidden));
    await page.reload();await page.waitForFunction(()=>window.__dietAppReady);
    await addTestMeal();
    await page.locator('#submitButton').click();await page.waitForFunction(()=>document.querySelector('#submitButton').disabled);
    await page.waitForFunction(()=>!state.saveInFlight);
    assert.ok(await page.locator('#friendFollowup').evaluate(node=>node.hidden));
    await page.locator('#mealTabs button').first().click();
    await page.locator('#manualModeButton').click();
    await page.waitForFunction(()=>document.activeElement?.id==='customFoodKcal');
    await page.locator('#customFoodName').fill('朋友流程也保留餐點草稿');
    await go('wall');await page.waitForTimeout(60);
    assert.equal(await page.locator('#view-wall #friendsIntro').evaluate(node=>node.open),true,'users with no groups see the short introduction');
    await page.evaluate(()=>{clearTimeout(showToast.timer);document.getElementById('toast').classList.remove('show');});
    await page.locator('#view-wall #friendSpaces').screenshot({path:'/tmp/calorie-friends-new-user.png',style:'#bottomNav {visibility:hidden !important}'});
    await page.screenshot({path:'/tmp/calorie-friends-empty.png',fullPage:true});
    await page.locator('#view-wall #friendsCreateToggle').click();
    await page.locator('#view-wall #friendsName').fill('一起好好吃飯');
    await go('personal');await page.locator('#view-personal #name').fill('保留未儲存名字');
    await go('wall');assert.equal(await page.locator('#view-wall #friendsName').inputValue(),'一起好好吃飯');
    const beforeCreates=calls.filter(c=>c.method==='createCheckInSpaceForClient').length;
    await page.locator('#view-wall #friendsCreateForm button').dblclick();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('#friendsStatus').textContent.includes('已建立'));
    assert.equal(calls.filter(c=>c.method==='createCheckInSpaceForClient').length,beforeCreates+1);
    await page.evaluate(()=>{Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{window.sharedInvite=data.text;}});});
    assert.equal(await page.locator('body > #app #publishToGroup').isChecked(),true,'create enables form sharing');
    assert.equal(await page.locator('#view-wall [data-wall-tab="group:space_1"] .friends-type').textContent(),'打卡空間');
    assert.equal(await page.locator('#view-wall [data-friend-type="space"] [data-friend-line-guide]').count(),0);
    assert.ok((await page.locator('#view-wall #friendsPrivacy').textContent()).includes('好友分享已開啟'));
    const ownerCard=page.locator('#view-wall .friends-space').filter({has:page.locator('[data-friend-view="space_1"]')});
    assert.equal(await ownerCard.locator('[data-friend-invite]').isVisible(),false,'invitation actions start collapsed');
    await openFriendMenu(ownerCard);
    await page.locator('#view-wall [data-friend-invite]').click();
    const invite=await page.evaluate(()=>window.sharedInvite);
    assert.ok(invite.includes('https://lin.ee/VdKn7XU'));assert.ok(invite.includes('MMABC123'));
    assert.ok(!invite.includes('sig='));assert.ok(!invite.includes('uid='));
    await ownerCard.locator('.friends-invite > summary').click();
    assert.equal(await ownerCard.locator('.friends-invite pre').isVisible(),true,'manual invitation copy remains available');
    await page.screenshot({path:'/tmp/calorie-friends-space.png',fullPage:true});
    await page.locator('#view-wall #friendSpaces').screenshot({path:'/tmp/calorie-friends-card.png'});
    await page.locator('#view-wall #friendsJoinToggle').click();
    await page.locator('#view-wall #friendsCode').fill('EXPIRED');
    await page.locator('#view-wall #friendsJoinForm button').click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('#friendsStatus').textContent.includes('過期'));
    assert.equal(await page.locator('#view-wall #friendsCode').inputValue(),'EXPIRED');
    await page.locator('#view-wall #friendsCode').fill('MMFRIEND');
    await page.locator('#view-wall #friendsJoinForm button').click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelectorAll('.friends-space').length===2);
    const guest=page.locator('#view-wall .friends-space').filter({hasText:'朋友的打卡空間'});
    assert.equal(await guest.locator('[data-friend-invite]').count(),0);
    assert.equal(await guest.locator('.friends-more').count(),0,'members without invitation actions have no empty menu');
    assert.equal(await ownerCard.locator('.friends-invite pre').isVisible(),true,'open invitation survives the refreshed group list');
    // A newly joined space enables sharing in both views; explicitly turning it off persists.
    await go('personal');
    assert.equal(await page.locator('#view-personal #publishToGroup').isChecked(),true);
    await page.locator('#view-personal #publishToGroup').uncheck();
    await page.locator('#view-personal #saveSettings').click();
    await page.waitForFunction(()=>!settingsWriteBusy && !MEMBER.defaultPublishToGroup);
    assert.equal(member.defaultPublishToGroup,false);
    await go('form');
    assert.equal(await page.locator('body > #app #publishToGroup').isChecked(),false);
    await go('wall');
    await page.locator('#view-wall #friendsJoinToggle').click();
    await page.locator('#view-wall #friendsCode').fill('MMFRIEND');
    await page.locator('#view-wall #friendsJoinForm button').click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('#friendsStatus').textContent.includes('已經在'));
    assert.equal(await page.locator('#view-wall .friends-space').count(),2);
    assert.equal(member.defaultPublishToGroup,false,'duplicate join keeps explicit opt-out');
    await go('personal');
    assert.equal(await page.locator('#view-personal #publishToGroup').isChecked(),false);
    assert.equal(await page.locator('#view-personal #name').inputValue(),'保留未儲存名字');
    await go('form');assert.equal(await page.locator('#customFoodName').inputValue(),'朋友流程也保留餐點草稿');
    await page.evaluate(()=>showFriendFollowup_());
    assert.ok((await page.locator('#friendFollowup').textContent()).includes('看看朋友的紀錄'));
    assert.equal(await page.locator('body > #toast').evaluate(node=>node.classList.contains('show')),false,'completion toast does not cover friend actions');
    await page.screenshot({path:'/tmp/calorie-friends-complete.png',fullPage:false});
    await page.locator('#friendFollowup .friend-open').click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('[data-wall-tab="group:space_1"]').classList.contains('active'));
    includeLegacyGroup=true;
    await page.evaluate(async()=>{appRouter.invalidate('wall');await appRouter.state('wall').request;});
    assert.equal(await page.locator('#view-wall [data-friend-type="line_group"]').count(),1);
    assert.equal(await page.locator('#view-wall [data-friend-type="space"]').count(),2);
    await page.locator('#view-wall [data-friend-type="line_group"] [data-friend-view]').click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('#heroDate').textContent.includes('LINE 群組'));
    await page.locator('#view-wall [data-friend-type="space"] [data-friend-view]').first().click();
    await page.waitForFunction(()=>document.querySelector('#view-wall').shadowRoot.querySelector('#heroDate').textContent.includes('打卡空間'));
    assert.equal(await lineCard.locator('.friends-more').evaluate(node=>node.open),false,'a refreshed list does not open another group menu');
    await openFriendMenu(lineCard);
    await page.locator('#view-wall [data-friend-line-guide]').click();
    const originalSpaceName=spaces[0].name;
    spaces[0].name='一起好好吃飯也一起認真運動的超長名稱朋友打卡空間';
    await page.evaluate(async()=>{appRouter.invalidate('wall');await appRouter.state('wall').request;});
    assert.equal(await ownerCard.locator('.friends-invite pre').isVisible(),true,'background refresh keeps each disclosure state by group');
    await page.locator('#view-wall .friends-more').evaluateAll(nodes=>nodes.forEach(node=>{node.open=false;}));
    for(const width of [320,390,760]) {
      await page.setViewportSize({width,height:844});
      assert.equal(await page.locator('#view-wall #friendSpaces').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'friends card does not overflow at '+width);
      assert.equal(await page.locator('#view-wall #friendsLineGuide').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'guide does not overflow at '+width);
      assert.equal(await page.locator('#view-wall #wallTabs').evaluate(node=>node.parentElement.scrollWidth<=node.parentElement.clientWidth),true,'source tabs stay within page at '+width);
      assert.equal(await page.locator('#view-wall .friends-space').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().height<=70 && node.scrollWidth<=node.clientWidth)),true,'closed group rows stay compact, including long names at '+width);
      if(width===390) await page.locator('#view-wall #friendSpaces').screenshot({path:'/tmp/calorie-friends-methods.png'});
    }
    spaces[0].name=originalSpaceName;
    await page.evaluate(async()=>{appRouter.invalidate('wall');await appRouter.state('wall').request;document.querySelector('#view-wall').shadowRoot.querySelector('#friendsIntro').open=false;});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#view-wall #friendSpaces').screenshot({path:'/tmp/calorie-friends-compact.png',style:'#bottomNav {visibility:hidden !important}'});
    console.log('Passed friend spaces, private invitations, error recovery, seven-day prompt, direct group navigation and mobile widths');
    assert.deepEqual(errors,[]);
    // Real startup failure: a bad/missing include must not render a working-looking form,
    // start RPC reads/writes, or replace the first error with a downstream missing symbol.
    const broken=await browser.newPage({viewport:{width:390,height:844}});
    const startupErrors=[];
    broken.on('pageerror',error=>startupErrors.push(error.message));
    await broken.addInitScript(()=>{
      window.startupRpcCalls=0;
      const run=new Proxy({}, {get(){return ()=>{window.startupRpcCalls++;return run;};}});
      window.google={script:{run}};
    });
    await broken.route('http://startup.test/**',route=>{
      const url=new URL(route.request().url());
      return route.fulfill({contentType:'text/html',body:html(url.searchParams.get('entry'),url.searchParams.get('fault'))});
    });
    for(const entry of ['form','history']) for(const fault of ['syntax','missing-runtime','missing-modules']) {
      startupErrors.length=0;
      await broken.goto('http://startup.test/?entry='+entry+'&fault='+fault);
      await broken.waitForFunction(()=>window.__dietAppFailed);
      assert.equal(await broken.evaluate(()=>window.__dietAppReady),false);
      assert.equal(await broken.locator('#submitBar').isVisible(),false);
      assert.equal(await broken.locator('#bottomNav').isVisible(),false);
      assert.equal(await broken.locator('#spaViews').isVisible(),false);
      const firstError=await broken.locator('#app').textContent();
      assert.ok(firstError.includes('畫面載入失敗'));
      if(fault==='syntax') {
        assert.equal(startupErrors.length,1);
        assert.ok(firstError.includes('SyntaxError'));
        assert.ok(!firstError.includes('DietRouter is not defined'));
      } else {
        assert.deepEqual(startupErrors,[]);
        assert.ok(firstError.includes('共用程式未完整載入'));
      }
      await broken.evaluate(()=>window.onerror('DietRouter is not defined','',99,1));
      assert.equal(await broken.locator('#app').textContent(),firstError);
      assert.equal(await broken.evaluate(()=>window.startupRpcCalls),0);
    }
    await broken.close();
    console.log('Passed startup syntax/missing dependency failures for form and history; first error retained and inactive controls hidden');
    console.log('PASS: four views, repeated navigation, draft fields, filters/calendar/scroll, wall date, failure retry, prepared deep links, no iframe or JS errors.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
