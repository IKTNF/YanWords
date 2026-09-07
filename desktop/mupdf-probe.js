// 探测 mupdf API 与渲染速度（ESM 动态导入）
const fs = require('fs');
(async()=>{
  const mupdf = await import('mupdf');
  const buf = fs.readFileSync('D:/黄皮书/历年考研英语真题解析及复习思路(基础版)（2007-2013）.pdf');
  const t0 = Date.now();
  const doc = mupdf.Document.openDocument(buf, 'application/pdf');
  console.log('open ms:', Date.now()-t0, '| pages:', doc.countPages());
  const page = doc.loadPage(29);
  const pix = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true);
  console.log('pix:', pix.getWidth(), 'x', pix.getHeight());
  const t1 = Date.now();
  const png = pix.asPNG();
  console.log('png ms:', Date.now()-t1, '| type:', png.constructor.name, '| KB:', Math.round(png.length/1024));
  let total = 0;
  for(let i=0;i<10;i++){
    const p = doc.loadPage(i);
    const t = Date.now();
    const px = p.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true);
    px.asPNG();
    total += Date.now()-t;
  }
  console.log('10页@1.5x 平均 ms/页:', Math.round(total/10));
  let t2 = 0;
  for(let i=0;i<10;i++){
    const p = doc.loadPage(i);
    const t = Date.now();
    const px = p.toPixmap(mupdf.Matrix.scale(0.42, 0.42), mupdf.ColorSpace.DeviceRGB, false, true);
    px.asPNG();
    t2 += Date.now()-t;
  }
  console.log('10页@0.42x 平均 ms/页:', Math.round(t2/10));
  doc.destroy();
})();
