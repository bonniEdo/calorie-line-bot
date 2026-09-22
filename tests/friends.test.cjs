const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('apps-script/Code.gs', 'utf8');
const runtime = fs.readFileSync('apps-script/SpaRuntime.html', 'utf8').replace(/<\/?script>/g, '');
const ownerSpace = { groupId:'space_1', name:'一起好好吃飯', isOwner:true, inviteCode:'MMABC123', inviteExpiresAt:'2026-10-01 18:00', inviteActive:true };

test('web join requires form scope before reading an invite or membership', () => {
  const c = vm.createContext({}); vm.runInContext(source, c);
  c.inspectAccessToken_ = (uid, sig, scope) => { assert.equal(scope,'form'); return sig === 'form' ? 'ok' : 'invalid'; };
  let joined = 0;
  c.joinCheckInSpaceByInvite_ = (uid, code) => { joined++; assert.equal(uid,'me'); assert.equal(code,'MMABC123'); return {}; };
  c.getCheckInSpacesForUser_ = () => [];
  c.getWallTabsForUser_ = () => [];
  c.getMemberById_ = () => ({defaultPublishToGroup:true});
  for (const sig of ['hub','wall','']) assert.throws(() => c.joinCheckInSpaceForClient({uid:'me',sig,inviteCode:'MMABC123'}));
  assert.equal(joined,0);
  assert.equal(c.joinCheckInSpaceForClient({uid:'me',sig:'form',inviteCode:'MMABC123'}).ok,true);
  assert.equal(joined,1);
});

test('invalid/expired invites do not write; repeated join is idempotent', () => {
  let writes = 0, releases = 0, flushes = 0;
  const c = vm.createContext({
    LockService:{getScriptLock:() => ({tryLock:() => true,releaseLock:() => releases++})},
    SpreadsheetApp:{flush:() => flushes++},
  });
  vm.runInContext(source,c);
  const group = {groupId:'space_1',type:'space',enabled:true,inviteCode:'MMABC123',inviteExpiresAt:new Date(Date.now()+86400000)};
  c.getGroups_ = () => [group];
  c.getGroupById_ = () => group;
  c.getGroupMemberships_ = () => writes ? [{userId:'me',inGroup:true}] : [];
  c.upsertGroupMember_ = () => writes++;
  c.upsertMember_ = () => assert.fail('joining must not change sharing settings');
  c.formatCheckInSpace_ = () => ({groupId:group.groupId});
  assert.throws(() => c.joinCheckInSpaceByInvite_('me','UNKNOWN'), /找不到/);
  group.inviteExpiresAt = new Date(0);
  assert.throws(() => c.joinCheckInSpaceByInvite_('me','MMABC123'), /過期/);
  assert.equal(writes,0);
  group.inviteExpiresAt = new Date(Date.now()+86400000);
  assert.equal(c.joinCheckInSpaceByInvite_('me','mm-abc123').alreadyJoined,false);
  assert.equal(c.joinCheckInSpaceByInvite_('me','MMABC123').alreadyJoined,true);
  assert.equal(writes,1); assert.equal(flushes,1); assert.equal(releases,4);
});

test('only the owner receives a usable invitation', () => {
  const c = vm.createContext({Utilities:{formatDate:() => '2026-10-01 18:00'}});
  vm.runInContext(source,c);
  c.getActiveGroupMemberIds_ = () => ['owner','guest'];
  const space = {groupId:'space_1',type:'space',enabled:true,name:'朋友',ownerUserId:'owner',inviteCode:'MMABC123',inviteExpiresAt:new Date(Date.now()+86400000)};
  const owner = c.formatCheckInSpace_(space,'owner');
  const guest = c.formatCheckInSpace_(space,'guest');
  assert.equal(owner.inviteActive,true); assert.equal(owner.inviteCode,'MMABC123');
  assert.equal(guest.inviteActive,false); assert.equal(guest.inviteCode,'');
  assert.equal(guest.inviteExpiresAt,'');
});

function helper(navigator = {}, document = {}) {
  const c = vm.createContext({navigator,document});
  vm.runInContext(runtime+'\nthis.friends = DietFriends;',c);
  return c.friends;
}

test('invitation contains all steps and public LINE link, never personal credentials', () => {
  const text = helper().inviteText({...ownerSpace,uid:'private-user',sig:'private-token',url:'https://private.invalid'});
  for (const part of ['一起好好吃飯','https://lin.ee/VdKn7XU','MMABC123','紀錄牆 → 輸入邀請碼','不會建立 LINE 聊天群','自動開啟好友分享','LINE 群組與打卡空間','可在設定關閉','不會自動公開到所有人']) assert.ok(text.includes(part));
  for (const part of ['private-user','private-token','private.invalid']) assert.ok(!text.includes(part));
});

test('wall sources distinguish spaces and legacy LINE groups without exposing invitations', () => {
  const c = vm.createContext({}); vm.runInContext(source, c);
  c.getActiveGroupIdsForUser_ = () => ['line', 'space', 'disabled'];
  c.getGroups_ = () => [
    {groupId:'line',name:'LINE 朋友',enabled:true},
    {groupId:'space',name:'邀請碼朋友',type:'space',enabled:true,inviteCode:'PRIVATE',ownerUserId:'owner'},
    {groupId:'disabled',name:'已停用',enabled:false},
    {groupId:'unjoined',name:'別人的群',type:'space',enabled:true},
  ];
  c.getGroupWallUrl_ = (uid, id) => '/wall/' + id;
  const tabs = JSON.parse(JSON.stringify(c.getWallTabsForUser_('me')));
  assert.deepEqual(tabs,[
    {groupId:'line',name:'LINE 朋友',type:'line_group'},
    {groupId:'space',name:'邀請碼朋友',type:'space'},
  ]);
  const links = JSON.parse(JSON.stringify(c.getGroupWallLinksForUser_('me')));
  assert.deepEqual(links,tabs.map(group=>({...group,url:'/wall/'+group.groupId})));
});

test('share cancellation does not copy; unsupported share falls back to clipboard', async () => {
  let copied = '', notices = [];
  const nav = {share:async () => {throw Object.assign(new Error(),{name:'AbortError'});},clipboard:{writeText:async text => {copied=text;}}};
  const friends = helper(nav);
  await friends.share(ownerSpace,text => notices.push(text));
  assert.equal(copied,''); assert.deepEqual(notices,[]);
  nav.share = async () => {throw new Error('Permission denied');};
  await friends.share(ownerSpace,text => notices.push(text));
  assert.ok(copied.includes('MMABC123')); assert.ok(notices[0].includes('已複製'));
  copied=''; await friends.share({...ownerSpace,inviteActive:false},text => notices.push(text));
  assert.equal(copied,'');
});

test('failed clipboard fallback never reports a successful copy', async () => {
  const notices=[];
  const friends = helper({}, {createElement:() => ({style:{},select(){},remove(){}}),body:{append(){}},execCommand:() => false});
  await friends.share(ownerSpace,text => notices.push(text));
  assert.match(notices[0],/長按複製/);
  assert.ok(!notices[0].includes('已複製'));
});

test('friend suggestions have a seven-day cooldown', () => {
  const friends = helper(); const now = Date.now();
  assert.equal(friends.canPrompt(null,now),true);
  assert.equal(friends.canPrompt(String(now),now),false);
  assert.equal(friends.canPrompt(now-6*86400000,now),false);
  assert.equal(friends.canPrompt(now-7*86400000,now),true);
});

function membershipBackend(initialRows = []) {
  let rows = initialRows.map(row => [...row]);
  const members = new Map(['me','known','new','left'].map(id => [id,{defaultPublishToGroup:false,defaultPublishToday:false,defaultPublishFoodDetails:false}]));
  const shared = [];
  const sheet = {
    getLastRow:() => rows.length+1,
    appendRow:row => rows.push([...row]),
    getRange:(start,col,count) => ({
      getValues:() => rows.slice(start-2,start-2+count).map(row => [...row]),
      setValues:values => values.forEach((row,i) => { rows[start-2+i]=[...row]; }),
    }),
  };
  const c = vm.createContext({CacheService:{getScriptCache:() => ({remove(){}})}});
  vm.runInContext(source,c);
  c.ensureGroupSheets_ = () => {};
  c.getSheet_ = () => sheet;
  c.invalidateGroupWallCachesForGroup_ = () => {};
  c.getMemberById_ = id => members.get(id);
  c.upsertMember_ = update => {
    assert.deepEqual(Object.keys(update).sort(),['defaultPublishToGroup','userId']);
    Object.assign(members.get(update.userId),update);
  };
  c.setGroupWallVisibilityForUser_ = (id,visible) => shared.push({id,visible});
  return {c,members,shared};
}

test('new membership enables group and historical sharing; opt-out survives repeat events until rejoining', () => {
  const {c,members,shared} = membershipBackend();
  c.upsertGroupMember_('group','me',true);
  assert.equal(members.get('me').defaultPublishToGroup,true);
  assert.deepEqual(shared,[{id:'me',visible:true}]);
  assert.equal(members.get('me').defaultPublishToday,false);
  assert.equal(members.get('me').defaultPublishFoodDetails,false);
  members.get('me').defaultPublishToGroup=false;
  c.upsertGroupMember_('group','me',true);
  assert.equal(members.get('me').defaultPublishToGroup,false);
  assert.equal(shared.length,1);
  c.upsertGroupMember_('group','me',false);
  assert.equal(members.get('me').defaultPublishToGroup,false);
  c.upsertGroupMember_('group','me',true);
  assert.equal(members.get('me').defaultPublishToGroup,true);
  assert.equal(shared.length,2);
});

test('LINE member sync only applies default sharing to newly active members', () => {
  const {c,members,shared} = membershipBackend([['group','known',true,'',''],['group','left',true,'','']]);
  const statuses = [{userId:'known',inGroup:true},{userId:'new',inGroup:true},{userId:'left',inGroup:false}];
  c.applyGroupMembershipStatuses_('group',statuses);
  assert.deepEqual(shared,[{id:'new',visible:true}]);
  assert.equal(members.get('known').defaultPublishToGroup,false);
  assert.equal(members.get('left').defaultPublishToGroup,false);
  members.get('new').defaultPublishToGroup=false;
  c.applyGroupMembershipStatuses_('group',statuses);
  assert.equal(members.get('new').defaultPublishToGroup,false);
  assert.equal(shared.length,1);
});

test('background sharing refresh cannot overwrite an unsaved opt-out; successful join can apply its default', () => {
  const frontend = fs.readFileSync('apps-script/Index.html','utf8');
  const start = frontend.indexOf('    function syncGroupSharing_(');
  const end = frontend.indexOf('    async function manageFriendSpace_',start);
  const input = {checked:false};
  const c = vm.createContext({MEMBER:{defaultPublishToGroup:false},settingsWriteBusy:false,
    state:{saveInFlight:false,mealRevision:2,savedMealRevision:1,draftStored:false},
    document:{getElementById:() => input},updatePublicSettingsSummary(){},persistLocalDraft_(){}});
  vm.runInContext(frontend.slice(start,end),c);
  c.syncGroupSharing_(true);
  assert.equal(input.checked,false);
  assert.equal(c.MEMBER.defaultPublishToGroup,false);
  c.syncGroupSharing_(true,true);
  assert.equal(input.checked,true);
  assert.equal(c.MEMBER.defaultPublishToGroup,true);
  c.state.savedMealRevision=2;
  c.syncGroupSharing_(false);
  assert.equal(input.checked,false);
});
