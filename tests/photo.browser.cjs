// Isolated image-processing regression and benchmark; all images are synthetic.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const source=fs.readFileSync('apps-script/Index.html','utf8');
const start=source.indexOf('    function compressPhoto(');
const current=source.slice(start,source.indexOf('\n    function ',start+1));
const legacy=fs.readFileSync('tests/fixtures/compress-photo-v134.js','utf8');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.SPA_BROWSER_CHANNEL?{channel:process.env.SPA_BROWSER_CHANNEL}:{})});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({content:legacy+'\n'+current});
    const report=await page.evaluate(async()=>{
      const created=new Set();
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=create(blob);created.add(url);return url;};
      URL.revokeObjectURL=url=>{created.delete(url);revoke(url);};
      const fixture=async(width,height,seed=12345)=>{
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(width,height);
        for(let i=0;i<pixels.data.length;i+=4) {
          seed=(Math.imul(seed,1664525)+1013904223)>>>0;
          pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;
        }
        ctx.putImageData(pixels,0,0);
        return new File([await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.92))],'synthetic.jpg',{type:'image/jpeg'});
      };
      const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
      const rows=[];
      for(const [width,height] of [[640,960],[1280,960],[4032,3024]]) {
        const oldTimes=[],newTimes=[];
        let oldOutput,newOutput,inputBytes=0,outputIdentical=true;
        // Use different images per sample so Chrome's decoded data-URL cache cannot
        // turn repeated uploads into a misleading first-photo speed measurement.
        for(let i=0;i<5;i++) {
          const file=await fixture(width,height,12345+i*1234567);inputBytes=file.size;
          for(const mode of i%2?['new','old']:['old','new']) {
            const begin=performance.now();
            const output=await(mode==='old'?compressPhotoLegacy(file):compressPhoto(file));
            (mode==='old'?oldTimes:newTimes).push(performance.now()-begin);
            if(mode==='old')oldOutput=output;else newOutput=output;
          }
          outputIdentical=outputIdentical&&oldOutput===newOutput;
        }
        const decoded=new Image();decoded.src=newOutput;await decoded.decode();
        rows.push({width,height,inputBytes,outputWidth:decoded.width,outputHeight:decoded.height,outputIdentical,legacyMedianMs:median(oldTimes),currentMedianMs:median(newTimes),legacySamplesMs:oldTimes,currentSamplesMs:newTimes});
      }
      let invalidRejected=false,canvasFailureRejected=false;
      try {await compressPhoto(new File(['not an image'],'bad.png',{type:'image/png'}));}catch(error){invalidRejected=true;}
      const file=await fixture(32,32),original=HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL=()=> 'data:,';
      try {await compressPhoto(file);}catch(error){canvasFailureRejected=true;}
      finally {HTMLCanvasElement.prototype.toDataURL=original;}
      return {rows,invalidRejected,canvasFailureRejected,unreleasedUrls:created.size,userAgent:navigator.userAgent};
    });
    assert.deepEqual(errors,[]);
    assert.equal(report.invalidRejected,true);assert.equal(report.canvasFailureRejected,true);
    assert.equal(report.unreleasedUrls,0,'temporary image URLs must be released on both success and failure');
    for(const row of report.rows) {
      assert.equal(row.outputIdentical,true,'image output must remain identical to version 134');
      assert.ok(Math.max(row.outputWidth,row.outputHeight)<=1280);
    }
    const file=path.join(os.tmpdir(),'calorie-photo-performance.json');
    fs.writeFileSync(file,JSON.stringify(report,null,2));
    for(const row of report.rows) console.log(`${row.width}x${row.height}: preparation median ${row.legacyMedianMs.toFixed(1)} -> ${row.currentMedianMs.toFixed(1)} ms; identical JPEG output`);
    console.log('PASS: image processing, corrupt images, canvas failures and URL cleanup. Report: '+file);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
