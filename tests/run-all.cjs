// NODE_PATH / installed Playwright and SPA_BROWSER_CHANNEL are inherited by every suite.
// All suites use synthetic data and never call production services.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
process.chdir(path.resolve(__dirname,'..'));
const steps=[
  ['JavaScript syntax',['--check','cloudflare-worker/src/index.js']],
  ['Landing script syntax',['--check','docs/site.js']],
  ['Landing configuration syntax',['--check','docs/config.js']],
  ['All unit and regression tests',['--test',...fs.readdirSync('tests').filter(name=>name.endsWith('.test.cjs')).sort().map(name=>'tests/'+name)]],
  ['Landing page browser tests',['tests/site.browser.cjs']],
  ['Four-view SPA browser tests',['tests/spa.browser.cjs']],
  // Run measurements last and alone, avoiding competing browser CPU work.
  ['Image processing and performance comparison',['tests/photo.browser.cjs']],
];
const failed=[];
for(const [name,args] of steps) {
  console.log('\n'+name);
  const result=spawnSync(process.execPath,args,{stdio:'inherit',env:process.env});
  if(result.error||result.status!==0)failed.push(name);
}
if(failed.length) {console.error('FAILED: '+failed.join(', '));process.exitCode=1;}
else console.log('\nPASS: all test suites completed without failures.');
