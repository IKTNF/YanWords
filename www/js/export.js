'use strict';
/* ============ 导出：Word(docx) 与 PDF（导出记忆区当前分区，保持顺序，附音标） ============ */
function dateStr(){ return new Date().toISOString().slice(0,10); }

/* 当前分区名（用于标题与文件名；默认分区不额外标注） */
function zoneTag(){
  let n = '';
  try{ if(typeof MEM !== 'undefined' && MEM.zoneName) n = MEM.zoneName() || ''; }catch(e){ n = ''; }
  return n && n !== '默认分区' ? n : '';
}
function docTitle(){ const z = zoneTag(); return '考研英语一词汇笔记' + (z ? '（'+z+'）' : ''); }
function fileTitle(){ const z = zoneTag(); return '考研英语一词汇笔记' + (z ? '_'+z.replace(/[\\/:*?"<>|]/g,'_') : ''); }

function saveBlob(blob, name){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1500);
}

async function exportWordDoc(){
  const items = MEM.items;
  if(!items.length){ App.toast('当前分区为空，无可导出内容','err'); return; }
  try{ await ensureDocx(); }
  catch(e){ App.toast('Word 导出组件加载失败：'+(e&&e.message||e),'err'); return; }
  if(!window.docx){ App.toast('Word 导出组件加载失败，请通过启动脚本访问本程序','err'); return; }
  App.toast('正在导出 Word…');
  try{
    const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } = docx;
    const children = [
      new Paragraph({ heading:HeadingLevel.HEADING_1, alignment:AlignmentType.CENTER, spacing:{after:160},
        children:[new TextRun({ text:docTitle(), bold:true, size:36, font:'Microsoft YaHei' })] }),
      new Paragraph({ alignment:AlignmentType.CENTER, spacing:{after:320},
        children:[new TextRun({ text:'共 '+items.length+' 条 · 导出时间：'+new Date().toLocaleString('zh-CN'), size:20, color:'7A8194', font:'Microsoft YaHei' })] })
    ];
    items.forEach((it,i)=>{
      const phon = it.p ? ' ['+String(it.p).replace(/^\/|\/$/g,'')+']' : '';
      children.push(new Paragraph({ spacing:{after:200, line:320}, children:[
        new TextRun({ text:(i+1)+'. ', size:22, color:'9AA1B2' }),
        new TextRun({ text:it.w, bold:true, size:24, font:'Microsoft YaHei' }),
        new TextRun({ text:phon, size:20, color:'7A8194', font:'Microsoft YaHei' }),
        new TextRun({ text:'　'+it.d, size:24, font:'Microsoft YaHei' })
      ] }));
    });
    const doc = new Document({ sections:[{ properties:{}, children }] });
    const blob = await Packer.toBlob(doc);
    saveBlob(blob, fileTitle()+'_'+dateStr()+'.docx');
    App.toast('已导出 Word：'+items.length+' 条（分区「'+MEM.zoneName()+'」）');
  }catch(e){
    console.error(e);
    App.toast('Word 导出失败：'+(e&&e.message||e),'err');
  }
}

/* ---------- PDF ---------- */
let _fontsCache = null;
async function getFonts(){
  if(_fontsCache) return _fontsCache;
  const [reg, bold] = await Promise.all([
    fetch('fonts/NotoSansCJKsc-Regular.otf').then(r=>{ if(!r.ok) throw new Error('字体下载失败(404)'); return r.arrayBuffer(); }),
    fetch('fonts/NotoSansCJKsc-Bold.otf').then(r=>{ if(!r.ok) throw new Error('字体下载失败(404)'); return r.arrayBuffer(); })
  ]);
  _fontsCache = [reg, bold];
  return _fontsCache;
}

function wrapLines(text, font, size, maxW){
  const out = [];
  for(const para of String(text).split('\n')){
    if(para===''){ out.push(''); continue; }
    let line = '';
    for(const w of para.split(' ')){
      const cand = line ? line+' '+w : w;
      if(font.widthOfTextAtSize(cand, size) <= maxW){ line = cand; }
      else{
        if(line){ out.push(line); line = w; }
        else{
          let sub = '';
          for(const ch of w){
            if(sub && font.widthOfTextAtSize(sub+ch, size) > maxW){ out.push(sub); sub = ''; }
            sub += ch;
          }
          out.push(sub); line = '';
        }
      }
    }
    if(line) out.push(line);
  }
  return out;
}

async function exportPdfDoc(){
  const items = MEM.items;
  if(!items.length){ App.toast('当前分区为空，无可导出内容','err'); return; }
  try{ await ensurePdfLib(); }
  catch(e){ App.toast('PDF 导出组件加载失败：'+(e&&e.message||e),'err'); return; }
  if(!window.PDFLib){ App.toast('PDF 导出组件加载失败，请通过启动脚本访问本程序','err'); return; }
  App.toast('正在生成 PDF…（首次需加载中文字体，请稍候）');
  try{
    const { PDFDocument, rgb } = PDFLib;
    const [regB, boldB] = await getFonts();
    const doc = await PDFDocument.create();
    if(window.fontkit) doc.registerFontkit(window.fontkit);
    const fReg  = await doc.embedFont(regB,  {subset:true});
    const fBold = await doc.embedFont(boldB, {subset:true});
    const W = 595.28, H = 841.89, M = 56, cw = W-2*M, lineH = 15.5;
    let page = doc.addPage([W,H]); let y = H-66;
    const newPage = ()=>{ page = doc.addPage([W,H]); y = H-M; };

    page.drawText(docTitle(), {x:M, y, size:22, font:fBold, color:rgb(.13,.15,.20)}); y -= 32;
    page.drawText('共 '+items.length+' 条 · 导出时间：'+new Date().toLocaleString('zh-CN'), {x:M, y, size:10, font:fReg, color:rgb(.45,.49,.58)}); y -= 24;

    for(let i=0;i<items.length;i++){
      const it = items[i];
      const phon = it.p ? '  ['+String(it.p).replace(/^\/|\/$/g,'')+']' : '';
      const head = (i+1)+'. '+it.w+phon;
      if(y-24 < M) newPage();
      page.drawText(head, {x:M, y, size:12.5, font:fBold, color:rgb(.13,.15,.20)}); y -= 18;
      const mlines = wrapLines(it.d, fReg, 10.5, cw);
      for(const ln of mlines){
        if(y-lineH < M) newPage();
        page.drawText(ln, {x:M, y, size:10.5, font:fReg, color:rgb(.25,.28,.35)}); y -= lineH;
      }
      y -= 14;
    }
    const bytes = await doc.save();
    saveBlob(new Blob([bytes], {type:'application/pdf'}), fileTitle()+'_'+dateStr()+'.pdf');
    App.toast('已导出 PDF：'+items.length+' 条（分区「'+MEM.zoneName()+'」）');
  }catch(e){
    console.error(e);
    App.toast('PDF 导出失败（'+((e&&e.message)||e)+'），已打开打印窗口代替','err');
    printFallback();
  }
}

function printFallback(){
  const items = MEM.items;
  const rows = items.map((it,i)=>
    '<p style="margin:10px 0;font-size:12pt;line-height:1.6"><b>'+(i+1)+'. '+App.esc(it.w)+'</b>'
    + (it.p ? ' <span style="color:#777">['+App.esc(String(it.p).replace(/^\/|\/$/g,''))+']</span>' : '')
    + '&emsp;'+App.esc(it.d)+'</p>'
  ).join('');
  const w = window.open('','_blank','width=800,height=900');
  if(!w){ App.toast('浏览器拦截了弹窗，无法打印','err'); return; }
  w.document.write('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>'+App.esc(docTitle())+'</title></head>'
    +'<body style="font-family:SimSun,serif;padding:24px">'
    +'<h1 style="text-align:center">'+App.esc(docTitle())+'</h1>'
    +'<p style="text-align:center;color:#888">共 '+items.length+' 条 · '+new Date().toLocaleString('zh-CN')+'（在打印对话框中选择「另存为 PDF」即可得到 PDF 文件）</p>'
    + rows + '</body></html>');
  w.document.close();
  setTimeout(()=>{ w.focus(); w.print(); }, 500);
}
