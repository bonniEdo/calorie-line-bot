// Public landing page smoke test with local files; does not open LINE or real accounts.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.SPA_BROWSER_CHANNEL?{channel:process.env.SPA_BROWSER_CHANNEL}:{})});
  try {
    const page=await browser.newPage();
    const errors=[],missing=[];
    page.on('pageerror',error=>errors.push(error.message));
    const root=path.resolve('docs');
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.jpg':'image/jpeg','.webp':'image/webp'};
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.hostname!=='intro.test')return route.abort();
      const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)) {missing.push(url.pathname);return route.fulfill({status:404,body:'missing'});}
      return route.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
    });
    await page.goto('http://intro.test/');
    assert.equal(await page.locator('#line-link').isVisible(),true);
    assert.equal(await page.locator('#line-link').getAttribute('href'),'https://lin.ee/VdKn7XU');
    await page.waitForFunction(()=>document.getElementById('line-qr').naturalWidth>0);
    await page.locator('[data-preview="report"]').click();
    assert.equal(await page.locator('#report-preview').isVisible(),true);
    assert.equal(await page.locator('#history-preview').isVisible(),false);
    await page.locator('[data-preview="history"]').click();
    assert.equal(await page.locator('#history-preview').isVisible(),true);
    assert.equal(await page.locator('#report-preview').isVisible(),false);
    for(const width of [320,390,1280]) {
      await page.setViewportSize({width,height:844});
      const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
      if(!fits) {
        console.error(await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).map(node=>({tag:node.tagName,class:node.className,right:node.getBoundingClientRect().right,width:node.getBoundingClientRect().width})).filter(node=>node.right>innerWidth+1).slice(0,20)));
        await page.screenshot({path:'/tmp/calorie-landing-overflow.png',fullPage:true});
      }
      assert.equal(fits,true,'landing page must not overflow at '+width);
      if(width===320) {
        await page.evaluate(()=>window.scrollTo({top:0,left:0,behavior:'instant'}));
        await page.screenshot({path:'/tmp/calorie-landing-320.png'});
      }
    }
    assert.ok(await page.locator('meta[property="og:image"]').getAttribute('content'));
    assert.equal(await page.locator('link[rel="icon"]').count()>0,true);
    assert.deepEqual(missing,[]);assert.deepEqual(errors,[]);
    console.log('PASS: landing page assets, LINE link, QR code, history/report preview and mobile widths.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
