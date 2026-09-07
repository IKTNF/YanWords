'use strict';
/* ============ 工作区：文本模式（可点击单词）+ 扫描模式（图片显示 + 区域OCR识别） ============ */
const WS_EMPTY = '<div class="empty">📄 上传资料后，这里将显示可点击识别的英文<br><span class="empty-sub">单击查释义并标黄 · 长按拖拽框选词组 · 扫描版长按拖选区域识别文字</span></div>';

function djb2(s){ let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))>>>0; return h; }

const THUMB_CAP = 400;          // 速览缩略图最大缓存页数（大 PDF 不再无限累积内存）
const TV_SEG_H = 3600;          // 文本查看器每段画布高度上限（降低单页画布内存）

const WS = {
  docs: [], activeId: null, gesture: null,
  defEl: null, popupCtx: null,
  _imgObs: null, _txtObs: null,
  _renderQueue: [], _activeRenders: 0,
  _ocrWorker: null, _ocrWorkerPromise: null,
  _hintShown: false,

  init(){
    this.defEl = document.getElementById('wsDef');
    this.docEl = document.getElementById('wsDoc');
    document.getElementById('btnUpload').addEventListener('click', ()=>document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', e=>{ this.handleFiles([...e.target.files]); e.target.value=''; });
    // 拖拽上传
    const drop = this.docEl;
    drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', ()=>drop.classList.remove('dragover'));
    drop.addEventListener('drop', e=>{ e.preventDefault(); drop.classList.remove('dragover'); this.handleFiles([...e.dataTransfer.files]); });
    // 滚动时回收远处页面/文本块（防止快速拖动滚动条时渲染堆积）
    let scrollPending = false;
    drop.addEventListener('scroll', ()=>{
      const d = this.currentDoc();
      // 轻量动作直接做（不依赖 rAF，窗口被遮挡时同样有效）：缩略图缓存管理与补生成
      if(d && d.mode==='image' && d.thumbs){
        if(Object.keys(d.thumbs).length > THUMB_CAP) this.evictFarThumbs(d);
        this.kickThumbsSoon(d);
      }
      if(scrollPending) return;
      scrollPending = true;
      requestAnimationFrame(()=>{
        scrollPending = false;
        const dd = this.currentDoc();
        if(!dd) return;
        if(dd.mode==='image' || dd.mode==='textview'){
          this.gcPageImages(dd);
          if(dd.mode==='image' && dd.thumbs){
            // 视口内首个页面立即补速览缩略图（拖到哪显示到哪）
            const rootRect = this.docEl.getBoundingClientRect();
            const probe = document.elementFromPoint(rootRect.left + 10, rootRect.top + 40);
            const pageEl = probe && probe.closest ? probe.closest('.pdf-page') : null;
            if(pageEl) this.drawThumb(dd, +pageEl.dataset.page, pageEl);
          }
        }else{
          this.gcTextBlocks(dd);
        }
      });
    });
    // 手势
    drop.addEventListener('mousedown', this.onDown.bind(this));
    window.addEventListener('mousemove', this.onMove.bind(this));
    window.addEventListener('mouseup', this.onUp.bind(this));
    // 侧栏
    document.getElementById('btnClearMarks').addEventListener('click', ()=>this.clearMarks());
    document.getElementById('selectMode').addEventListener('change', e=>{ this.docEl.classList.toggle('selectable', e.target.checked); });
    document.getElementById('wsZoom').addEventListener('input', e=>{
      App.state.wsZoom = +e.target.value;
      document.getElementById('wsZoomVal').textContent = e.target.value+'px';
      this.applyZoom(); App.save();
    });
    // 多图拼接间距
    document.getElementById('photoGap').addEventListener('input', e=>{
      const doc = this.currentDoc();
      if(!doc || !doc.photoFiles) return;
      doc.photoGap = +e.target.value;
      document.getElementById('photoGapVal').textContent = e.target.value+'px';
      this.renderActive();
    });
    // 左右侧栏：拖动调宽 / 点击箭头隐藏，内容随宽度缩放
    this.leftEl = document.getElementById('wsSide');
    this.rightEl = document.getElementById('wsDef');
    document.getElementById('wsLeftHandle').addEventListener('mousedown', e=>{
      if(e.target.closest('.col-toggle')) return;
      e.preventDefault();
      if(App.state.wsLeftHidden){ App.state.wsLeftHidden = false; this.colDrag = {side:'left', startX:e.clientX, startW:160}; }
      else this.colDrag = {side:'left', startX:e.clientX, startW:App.state.wsLeftW||252};
      document.getElementById('wsLeftHandle').classList.add('active');
      this.applyCols();
    });
    document.getElementById('wsRightHandle').addEventListener('mousedown', e=>{
      if(e.target.closest('.col-toggle')) return;
      e.preventDefault();
      if(App.state.wsRightHidden){ App.state.wsRightHidden = false; this.colDrag = {side:'right', startX:e.clientX, startW:240}; }
      else this.colDrag = {side:'right', startX:e.clientX, startW:App.state.wsRightW||342};
      document.getElementById('wsRightHandle').classList.add('active');
      this.applyCols();
    });
    document.getElementById('wsLeftToggle').addEventListener('click', ()=>{
      App.state.wsLeftHidden = !App.state.wsLeftHidden;
      this.applyCols(); App.save();
    });
    document.getElementById('wsRightToggle').addEventListener('click', ()=>{
      App.state.wsRightHidden = !App.state.wsRightHidden;
      this.applyCols(); App.save();
    });
    this.applyCols();
    document.getElementById('docList').addEventListener('click', e=>{
      const close = e.target.closest('.doc-close');
      const item = e.target.closest('.doc-item');
      if(!item) return;
      const doc = this.docs.find(d=>d.id===item.dataset.id);
      if(!doc) return;
      if(close){
        if(doc.status){ doc.status.cancel = true; App.toast('正在取消，请稍候…'); }
        else this.removeDoc(item.dataset.id);
        return;
      }
      if(doc.status) return;
      this.activateDoc(item.dataset.id);
    });
    this.applyZoom();
    this.renderDocList();
    this.renderActive();
  },

  applyZoom(){
    const doc = this.currentDoc();
    if(doc && (doc.mode==='image' || doc.mode==='textview')){
      const w = Math.round(760 * (App.state.wsZoom||17) / 17);
      const fs = (App.state.wsZoom||17);
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>{
        el.style.width = w+'px';
        el.style.fontSize = fs+'px';
      });
    }else{
      this.docEl.style.fontSize = (App.state.wsZoom||17)+'px';
    }
  },

  /* 左右侧栏宽度/隐藏/内容缩放 */
  applyCols(){
    const apply = (el, w, hidden, baseW, minZ, maxZ)=>{
      if(!el) return;
      if(hidden){ el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.flex = 'none';
      const z = Math.min(maxZ, Math.max(minZ, w/baseW));
      el.style.zoom = z;
      el.style.width = (w/z)+'px';
    };
    apply(this.leftEl, App.state.wsLeftW||252, App.state.wsLeftHidden, 252, 0.8, 1.35);
    apply(this.rightEl, App.state.wsRightW||342, App.state.wsRightHidden, 342, 0.8, 1.4);
    const lt = document.getElementById('wsLeftToggle');
    const rt = document.getElementById('wsRightToggle');
    if(lt) lt.textContent = App.state.wsLeftHidden ? '›' : '‹';
    if(rt) rt.textContent = App.state.wsRightHidden ? '‹' : '›';
  },

  currentDoc(){ return this.docs.find(d=>d.id===this.activeId) || null; },

  /* ================= 文件处理 ================= */
  async handleFiles(files){
    const IMG = ['jpg','jpeg','png','webp','bmp','gif'];
    const extOf = f => (f.name.split('.').pop()||'').toLowerCase();
    // 图片统一合并为一个「图片模式」文档，每张图一页
    const imgs = files.filter(f=>IMG.includes(extOf(f)));
    if(imgs.length) this.addPhotoDoc(imgs);
    for(const f of files){
      const ext = extOf(f);
      if(IMG.includes(ext)) continue;
      if(!['pdf','docx','doc','txt','md'].includes(ext)){ App.toast('不支持的文件类型：'+f.name,'err'); continue; }
      const mb = f.size/1048576;
      if(f.size > 1024*1024*1024){ App.toast('文件过大（>1GB）：'+f.name+'，请先用 PDF 工具拆分后上传','err'); continue; }
      if((ext==='docx'||ext==='doc') && f.size > 300*1024*1024){ App.toast('Word 文档过大（>300MB）：'+f.name+'，请先拆分为多个文档后上传','err'); continue; }
      if(mb > 300) App.toast('文件较大（'+mb.toFixed(0)+'MB），解析可能需要较长时间，请耐心等待…');
      const doc = this.createDoc(f.name, f.size, f.lastModified, '');
      doc.status = { phase:'解析中', progress:0, cancel:false };
      this.renderDocList();
      try{
        const parsed = await this.parseFile(f, {
          onProgress: (phase, pct)=>{ if(doc.status){ doc.status.phase = phase; doc.status.progress = pct; this.renderDocList(); } },
          isCancelled: ()=> !!doc.status.cancel
        });
        if(parsed.mode === 'image'){
          doc.mode = 'image';
          doc.pdf = parsed.pdf;
          doc.mupdfId = parsed.mupdfId || null;
          doc.pageCount = parsed.pageCount;
          doc.range = parsed.range;
          doc.pages = [];
          doc.text = '';
          doc.status = null;
          this.renderDocList();
          this.activateDoc(doc.id);
          App.toast('已以查看模式打开（'+parsed.pageCount+' 页）：按住左键拖拽框选区域即可识别文字');
        }else{
          let text = parsed.text;
          if(!text.trim()){
            this.removeDocSilent(doc.id);
            App.toast('未提取到文字内容：'+f.name,'err');
            continue;
          }
          if(parsed.truncated || text.length > 3000000){
            text = text.slice(0, 3000000);
            App.toast('内容过长，已截断前 300 万字符');
          }
          // 文本类文件：查看器模式（转画布保持排版），区域框选识别
          doc.mode = 'textview';
          doc.text = text;
          doc.wordCount = countWords(text);
          doc.status = null;
          this.renderDocList();
          this.activateDoc(doc.id);
          App.toast('已以查看模式打开（约 '+doc.wordCount+' 词）：按住左键拖拽框选区域即可识别文字');
        }
      }catch(err){
        if(!(err && err.message && err.message.includes('已取消'))) console.error(err);
        this.removeDocSilent(doc.id);
        App.toast('处理中止 '+f.name+'：'+(err&&err.message||err),'err');
      }
    }
  },

  parseFile(file, opts){
    const ext = (file.name.split('.').pop()||'').toLowerCase();
    if(ext==='pdf') return this.parsePDF(file, opts);
    if(ext==='docx'||ext==='doc') return this.parseDocx(file).then(text=>({mode:'text', text, truncated:false}));
    return this.parseText(file);
  },

  /* 大文本文件：流式读取 + 达到 300 万字符即停止（不再把整个文件读进内存） */
  async parseText(file){
    const MAX_CHARS = 3000000;
    // 编码探测：UTF-8 优先（流式解码不会因 64KB 前缀末尾截断而误判），失败按 GB18030
    let enc = 'utf-8';
    const probe = await file.slice(0, 65536).arrayBuffer();
    try{ new TextDecoder('utf-8', {fatal:true}).decode(probe, {stream:true}); }
    catch(e){ enc = 'gb18030'; }
    if(file.size <= 8*1024*1024){
      const buf = await file.arrayBuffer();
      return { mode:'text', text: new TextDecoder(enc).decode(buf), truncated:false };
    }
    const td = new TextDecoder(enc, {stream:true});
    const reader = file.stream().getReader();
    let out = '';
    for(;;){
      const {value, done} = await reader.read();
      if(value && value.length){
        out += td.decode(value, {stream: !done});
        if(out.length >= MAX_CHARS){
          out = out.slice(0, MAX_CHARS);
          try{ await reader.cancel(); }catch(e){}
          return { mode:'text', text: out, truncated:true };
        }
      }
      if(done) break;
    }
    out += td.decode();
    return { mode:'text', text: out, truncated:false };
  },

  async parseDocx(file){
    await ensureMammoth();
    if(!window.mammoth) throw new Error('Word 解析组件未加载');
    try{
      const arrayBuffer = await file.arrayBuffer();
      // 用 HTML 转换保留段落/列表/表格等块级结构，再还原为带换行的文本（不破坏原排版）
      const res = await mammoth.convertToHtml({arrayBuffer});
      const dom = new DOMParser().parseFromString(res.value, 'text/html');
      dom.querySelectorAll('p,li,tr,br,h1,h2,h3,h4,h5,h6').forEach(el=>{
        el.insertAdjacentText('afterend', '\n');
      });
      dom.querySelectorAll('td,th').forEach(el=>{
        el.insertAdjacentText('beforeend', '\t');
      });
      return (dom.body ? dom.body.textContent : '').replace(/\n{3,}/g, '\n\n').replace(/\t+/g, '\t').trim();
    }catch(e){ throw new Error('无法解析（旧版 .doc 请先用 WPS/Word 另存为 .docx）'); }
  },

  async parsePDF(file, opts){
    // 桌面版：优先用 MuPDF 原生引擎按磁盘路径直接打开（大 PDF 零内存拷贝），浏览器回退 pdf.js
    let mupdfInfo = null;
    if(window.__mupdf && window.__mupdf.desktop){
      try{
        const p = window.__mupdf.pathForFile(file);
        if(p) mupdfInfo = await window.__mupdf.openPath(p);
      }catch(e){ console.warn('MuPDF 打开失败，回退 pdf.js', e); }
    }
    let pdf = null;
    if(!mupdfInfo || !mupdfInfo.ok){
      if(file.size > 300*1024*1024) throw new Error('PDF 体积过大且原生引擎未能打开，请检查文件是否损坏');
      await ensurePdfjs();
      if(!window.pdfjsLib) throw new Error('PDF 解析组件未加载');
      const buf = await file.arrayBuffer();
      pdf = await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
    }
    const total = (mupdfInfo && mupdfInfo.ok) ? mupdfInfo.pages : pdf.numPages;
    let start = 1, end = total;

    if(total > 300){
      const ans = await App.prompt('页码范围', '该 PDF 共 '+total+' 页。\n\n直接点「确定」= 打开全部；\n也可输入页码范围（如 120-180）只打开部分：','');
      if(ans !== null && ans.trim()){
        const m = ans.trim().match(/^\s*(\d+)\s*(?:-|~|—|到|至)\s*(\d+)\s*$/);
        if(m){
          start = Math.max(1, Math.min(+m[1], +m[2]));
          end = Math.max(+m[1], +m[2]);
          App.toast('页码范围：第 '+start+'-'+end+' 页');
        }else{
          App.toast('页码格式无法识别（示例：120-180），将打开全部');
        }
      }
    }
    if(end > total) end = total;
    if(start > end) start = end;
    // 所有 PDF 一律按查看器模式打开（展示原本版面），区域框选识别
    return {mode:'image', pdf, pageCount: total, range:{start, end}, mupdfId: (mupdfInfo && mupdfInfo.ok) ? mupdfInfo.id : null};
  },

  /* ================= 文档管理 ================= */
  createDoc(name, size, mtime, text){
    const id = 'doc-'+djb2(name+'|'+size+'|'+mtime).toString(36)+'-'+Date.now().toString(36);
    const doc = { id, name, size, mode:'text', text, marks:this.loadMarks(id), spans:[], html:null };
    this.docs.push(doc);
    this.renderDocList();
    return doc;
  },

  /* 图片上传：与扫描模式相同的框选识别流程 */
  addPhotoDoc(files){
    const name = files.length>1
      ? '照片组（'+files.length+' 张）· '+files.map(f=>f.name).slice(0,3).join('、')
      : files[0].name;
    const size = files.reduce((s,f)=>s+f.size,0);
    const doc = this.createDoc(name, size, files[0].lastModified, '');
    doc.mode = 'image';
    doc.photoFiles = files;
    doc.pageCount = files.length;
    doc.range = {start:1, end:files.length};
    doc.pages = [];
    this.renderDocList();
    this.activateDoc(doc.id);
    App.toast('已以图片模式打开（'+files.length+' 张）：按住左键拖拽框选区域即可识别文字');
  },

  activateDoc(id){
    this.activeId = id;
    this.renderDocList();
    this.renderActive();
  },

  async removeDoc(id){
    const doc = this.docs.find(d=>d.id===id);
    if(!doc) return;
    if(doc.marks.size && !(await App.confirm('移除文档「'+doc.name+'」？该文档的标黄记录将被清除。'))) return;
    this.removeDocSilent(id);
  },

  removeDocSilent(id){
    const doc = this.docs.find(d=>d.id===id);
    this.docs = this.docs.filter(d=>d.id!==id);
    const store = this.loadAllMarks(); delete store[id];
    localStorage.setItem('kyw_marks_v1', JSON.stringify(store));
    if(doc && doc.pdf){ try{ doc.pdf.destroy(); }catch(e){} }
    if(doc && doc.mupdfId && window.__mupdf){ try{ window.__mupdf.close(doc.mupdfId); }catch(e){} }
    if(doc && doc.photoMeta){ for(const it of doc.photoMeta){ try{ it.bmp && it.bmp.close(); }catch(e){} } doc.photoMeta = null; }
    // 仅当移除的是当前活动文档时才断开其观察器（避免殃及其他活动文档的懒渲染）
    if(doc && this.activeId===id){
      if(this._imgObs){ this._imgObs.disconnect(); this._imgObs = null; }
      if(this._txtObs){ this._txtObs.disconnect(); this._txtObs = null; }
    }
    if(this.activeId===id) this.activeId = this.docs.length ? this.docs[this.docs.length-1].id : null;
    this.renderDocList();
    this.renderActive();
    this.resetDef();
  },

  renderDocList(){
    const el = document.getElementById('docList');
    if(!this.docs.length){ el.innerHTML = '<div class="note-line" style="font-size:12px;color:var(--muted)">尚未上传文档</div>'; return; }
    el.innerHTML = this.docs.map(d=>{
      const size = d.size>1024*1024 ? (d.size/1024/1024).toFixed(1)+' MB' : Math.max(1,Math.round(d.size/1024))+' KB';
      const statusHtml = d.status
        ? '<span class="doc-status">'+App.esc(d.status.phase)+' '+Math.round(d.status.progress*100)+'%</span>'
        : '<span class="doc-status">'+(d.mode==='image'?'🖼 扫描模式 · ':'' )+size+'</span>';
      return `<div class="doc-item${d.id===this.activeId && !d.status?' active':''}${d.status?' busy':''}" data-id="${d.id}" title="${App.esc(d.name)}">
        <span class="doc-ico">${d.status?'<span class="spin"></span>':'📄'}</span>
        <span class="doc-name">${App.esc(d.name)}</span>
        ${statusHtml}
        <button class="doc-close" title="${d.status?'取消':'移除'}">✕</button>
      </div>`;
    }).join('');
  },

  renderActive(){
    const doc = this.currentDoc();
    const gapRow = document.getElementById('photoGapRow');
    if(gapRow) gapRow.style.display = (doc && doc.mode==='image' && doc.photoFiles && doc.photoFiles.length>1) ? '' : 'none';
    if(!doc){ this.docEl.innerHTML = WS_EMPTY; return; }
    this.docEl.scrollTop = 0;   // 切换/打开文档总是从顶部开始（旧内容高度相同时滚动位置不会被重置）
    if(doc.mode==='image' || doc.mode==='textview'){ this.renderImageDoc(doc); return; }
    this.renderTextDoc(doc);
    this.applyZoom();
  },

  /* ================= 文本模式：分块虚拟化渲染（大文件不卡死） ================= */
  renderTextDoc(doc){
    if(!doc.blocks){
      doc.blocks = splitBlocks(doc.text).map(t=>({text:t}));
      let gi = 0;
      for(const b of doc.blocks){ b.gi0 = gi; gi += countWords(b.text); }
      doc.wordCount = gi;
    }
    if(this._txtObs){ this._txtObs.disconnect(); this._txtObs = null; }
    this.docEl.innerHTML = doc.blocks.map((b,i)=>
      '<div class="ws-block" data-blk="'+i+'"><div class="ws-ph">'+App.esc(b.text)+'</div></div>'
    ).join('');
    this.applyZoom();
    this._txtObs = new IntersectionObserver(entries=>{
      for(const en of entries){
        const el = en.target;
        if(en.isIntersecting && !el.dataset.done) this.renderBlock(doc, +el.dataset.blk, el);
      }
      this.gcTextBlocks(doc);
    }, {root: this.docEl, rootMargin:'1500px 0px 1500px 0px'});
    this.docEl.querySelectorAll('.ws-block').forEach(el=>this._txtObs.observe(el));
  },

  renderBlock(doc, i, el){
    const b = doc.blocks[i];
    if(!b || el.dataset.done) return;
    el.innerHTML = this.buildHTML(b.text);
    const spans = el.querySelectorAll('.ws-word');
    spans.forEach((s, li)=>{
      const gi = b.gi0 + li;
      s.dataset.gi = gi;
      if(doc.marks.has(gi)) s.classList.add('marked');
    });
    el.dataset.done = '1';
  },

  gcTextBlocks(doc){
    const rootRect = this.docEl.getBoundingClientRect();
    const els = [...this.docEl.querySelectorAll('.ws-block')];
    let rendered = 0;
    const list = [];
    for(const el of els){
      if(!el.dataset.done) continue;
      const r = el.getBoundingClientRect();
      const dist = (r.bottom < rootRect.top) ? rootRect.top - r.bottom
                 : (r.top > rootRect.bottom) ? r.top - rootRect.bottom : 0;
      rendered++;
      list.push({el, dist});
    }
    for(const it of list){ if(it.dist > 5000){ this.freeBlock(doc, it.el); rendered--; } }
    if(rendered > 40){
      list.sort((a,b)=>b.dist-a.dist);
      let need = rendered - 40;
      for(const it of list){
        if(need <= 0) break;
        if(!it.el.dataset.done) continue;
        this.freeBlock(doc, it.el);
        need--;
      }
    }
  },

  freeBlock(doc, el){
    const b = doc.blocks[+el.dataset.blk];
    el.innerHTML = '<div class="ws-ph">'+App.esc(b ? b.text : '')+'</div>';
    delete el.dataset.done;
  },

  /* ---------- PDF 速览缩略图：后台按需生成（缓存有上限，大 PDF 围绕视口滑窗） ---------- */
  startThumbs(doc){
    if((!doc.pdf && !doc.mupdfId) || doc.mode!=='image' || doc.photoFiles || doc.stitchSegs) return;
    if(!doc._thumbStarted){ doc._thumbStarted = true; doc.thumbs = doc.thumbs || {}; }
    this.kickThumbs(doc);
  },

  /* 估算当前视口大致处于第几页（用于大文档缩略图滑窗，无需精确） */
  viewportPage(doc){
    const start = doc.range ? doc.range.start : 1;
    const end = doc.range ? doc.range.end : doc.pageCount;
    const w = Math.round(760 * (App.state.wsZoom||17) / 17);
    const h = w * 842/595 + 36;
    if(h <= 0) return start;
    const vp = start + Math.floor(this.docEl.scrollTop / h);
    return Math.max(start, Math.min(end, vp));
  },

  kickThumbs(doc){
    if(doc !== this.currentDoc()) return;
    if(doc.mode!=='image' || !doc.thumbs || (!doc.pdf && !doc.mupdfId)) return;   // 防御：仅图片/PDF 文档
    const start = doc.range ? doc.range.start : 1;
    const end = doc.range ? doc.range.end : doc.pageCount;
    const total = end - start + 1;
    let begin = start;
    if(total > THUMB_CAP){
      const vp = this.viewportPage(doc);
      begin = Math.max(start, Math.min(vp - 60, end));
    }
    if(doc._thumbBusy && Math.abs((doc._thumbLoop||begin) - begin) <= 120) return;
    doc._thumbBusy = true;
    doc._thumbLoop = begin;
    let i = begin;
    const step = async ()=>{
      if(doc !== this.currentDoc()){ doc._thumbBusy = false; return; }
      if(Object.keys(doc.thumbs).length >= THUMB_CAP){
        this.evictFarThumbs(doc);
        if(Object.keys(doc.thumbs).length >= THUMB_CAP){ doc._thumbBusy = false; return; }
      }
      let done = 0;
      while(i <= end && done < 3){
        const p = i++;
        if(doc.thumbs[p]){ done++; continue; }
        try{
          let c;
          if(doc.mupdfId && window.__mupdf){
            const r = await window.__mupdf.render(doc.mupdfId, p, 0.42);
            if(!r || !r.ok || !r.png) throw new Error('mupdf thumb 失败');
            const bmp = await createImageBitmap(new Blob([r.png], {type:'image/png'}));
            c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            c.getContext('2d').drawImage(bmp, 0, 0);
            bmp.close();
          }else{
            const page = await doc.pdf.getPage(p);
            const vp = page.getViewport({scale: 0.42});
            c = document.createElement('canvas');
            c.width = vp.width; c.height = vp.height;
            const ctx = c.getContext('2d');
            await page.render({canvasContext: ctx, viewport: vp}).promise;
            page.cleanup();
          }
          doc.thumbs[p] = c.toDataURL('image/jpeg', 0.6);
          c.width = c.height = 0;
        }catch(e){ /* 单页失败忽略 */ }
        done++;
      }
      if(i <= end && doc === this.currentDoc()){
        doc._thumbLoop = i;
        setTimeout(step, 60);
      }else{
        doc._thumbBusy = false;
      }
    };
    step();
  },

  /* 滚动停止后再补生成当前视口附近的缩略图 */
  kickThumbsSoon(doc){
    if(doc._kickTimer) return;
    doc._kickTimer = setTimeout(()=>{
      doc._kickTimer = null;
      this.kickThumbs(doc);
    }, 500);
  },

  /* 缩略图超限时丢弃离视口最远的页 */
  evictFarThumbs(doc){
    const keys = Object.keys(doc.thumbs);
    if(keys.length <= THUMB_CAP) return;
    const rootRect = this.docEl.getBoundingClientRect();
    const list = [];
    for(const k of keys){
      const el = this.docEl.querySelector('.pdf-page[data-page="'+k+'"]');
      let dist = 1e9;
      if(el){
        const r = el.getBoundingClientRect();
        dist = (r.bottom < rootRect.top) ? rootRect.top - r.bottom
             : (r.top > rootRect.bottom) ? r.top - rootRect.bottom : 0;
      }
      list.push([k, dist]);
    }
    list.sort((a,b)=>b[1]-a[1]);
    for(let n=0; n<list.length-THUMB_CAP; n++) delete doc.thumbs[list[n][0]];
  },

  drawThumb(doc, pageNum, el){
    const st = this.pageState(doc, pageNum);
    const data = doc.thumbs && doc.thumbs[pageNum];
    if(!data || st.rendered || st.thumb) return;
    const img = new Image();
    img.onload = ()=>{
      if(st.rendered || !el.isConnected || this.currentDoc()!==doc) return;
      const canvas = el.querySelector('.page-img');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.style.aspectRatio = img.width + ' / ' + img.height;
      canvas.classList.add('thumbed');
      st.thumb = true;
    };
    img.src = data;
  },

  /* ================= 文本查看器模式：转画布保持排版，区域框选识别 ================= */
  renderTextViewDoc(doc){
    if(!doc.tvSegs){
      doc.tvSegs = this.buildTextSegments(doc.text);
      doc.text = '';   // 排版数据已齐备，释放原文（大文件省内存）
    }
    const segs = doc.tvSegs;
    if(this._imgObs){ this._imgObs.disconnect(); this._imgObs = null; }
    doc.pages = [];
    this.docEl.innerHTML = segs.map((s,i)=>
      '<div class="pdf-page" data-page="'+(i+1)+'">'
      + '<div class="page-canvas-wrap">'
      + '<canvas class="page-img" style="aspect-ratio:'+s.w+'/'+s.h+'"></canvas>'
      + '<div class="page-overlays"></div>'
      + '</div>'
      + '<div class="page-label">文本 '+(i+1)+'/'+segs.length+' · 长按拖拽框选区域识别文字</div>'
      + '</div>').join('');
    this.applyZoom();
    // 前两页立即同步渲染（首屏零等待，不等 IntersectionObserver）
    {
      const els = this.docEl.querySelectorAll('.pdf-page');
      for(let k=0; k<Math.min(2, els.length); k++){
        const el = els[k];
        if(!this.pageState(doc, +el.dataset.page).rendered) this.renderTextSegment(doc, +el.dataset.page, el);
      }
    }
    // 与扫描模式一致：只渲染视口附近的分段，远处画布及时回收（大文本不再撑爆内存）
    if('IntersectionObserver' in window){
      this._imgObs = new IntersectionObserver(entries=>{
        for(const en of entries){
          if(en.isIntersecting){
            const el = en.target;
            const st = this.pageState(doc, +el.dataset.page);
            if(!st.rendered && !st.rendering) this.enqueuePageRender(doc, +el.dataset.page, el);
          }
        }
        this.gcPageImages(doc);
      }, {root: this.docEl, rootMargin: '900px 0px 900px 0px'});
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this._imgObs.observe(el));
    }else{
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this.renderTextSegment(doc, +el.dataset.page, el));
    }
  },

  buildTextSegments(text){
    const W = 1600, LH = 48, MARGIN = 40, TOP = 48;
    const FONT = '34px Georgia, "Times New Roman", "Microsoft YaHei", serif';
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = FONT;
    // 逐词缓存测宽：大文本下 measureText 次数从「每词一次」降为「每唯一词一次」
    const wCache = new Map();
    const wOf = (t)=>{
      let v = wCache.get(t);
      if(v === undefined){ v = ctx.measureText(t).width; wCache.set(t, v); }
      return v;
    };
    const SP = wOf(' ');
    const maxW = W - MARGIN*2;
    const segs = [];
    let lines = [];
    let h = TOP;
    const flush = ()=>{ if(lines.length){ segs.push({w:W, h:h+MARGIN, lines}); lines = []; h = TOP; } };
    for(const rawPara of String(text).split('\n')){
      const para = rawPara.replace(/\t/g, '    ');
      if(!para){ h += LH; if(h > TV_SEG_H) flush(); continue; }
      let line = '';
      let lineW = 0;
      const pushLine = ()=>{ lines.push(line); h += LH; if(h > TV_SEG_H) flush(); };
      const addWord = (w)=>{
        const ww = wOf(w);
        const need = line ? lineW + SP + ww : ww;
        if(need > maxW && line){ pushLine(); line = w; lineW = ww; }
        else{ line = line ? line+' '+w : w; lineW = need; }
      };
      for(const w of para.split(' ')){
        // CJK 逐字换行；拉丁按词累积
        let unit = '';
        const flushUnit = ()=>{
          if(!unit) return;
          addWord(unit);
          unit = '';
        };
        for(const ch of w){
          if(/[\u4e00-\u9fff]/.test(ch)){
            flushUnit();
            const cw = wOf(ch);
            const need = line ? lineW + cw : cw;
            if(need > maxW && line){ pushLine(); line = ch; lineW = cw; }
            else{ line = line + ch; lineW = need; }
          }else{
            unit += ch;
          }
        }
        flushUnit();
      }
      if(line){ pushLine(); }
    }
    flush();
    return segs.length ? segs : [{w:W, h:TOP+MARGIN, lines:[]}];
  },

  renderTextSegment(doc, segIdx, el){
    const seg = doc.tvSegs[segIdx-1];
    if(!seg) return;
    const st = this.pageState(doc, segIdx);
    if(st.rendered) return;
    const canvas = el.querySelector('.page-img');
    canvas.width = seg.w; canvas.height = seg.h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, seg.w, seg.h);
    ctx.fillStyle = '#1a1f2b';
    ctx.font = '34px Georgia, "Times New Roman", "Microsoft YaHei", serif';
    ctx.textBaseline = 'top';
    let y = 48;
    for(const ln of seg.lines){ ctx.fillText(ln, 40, y); y += 48; }
    canvas.style.aspectRatio = seg.w + ' / ' + seg.h;
    st.rendered = true;
    canvas.classList.add('loaded');
  },

  /* ================= 扫描模式：图片显示 + 区域OCR ================= */
  renderImageDoc(doc){
    if(doc.mode==='textview'){ this.renderTextViewDoc(doc); return; }
    const start = doc.range ? doc.range.start : 1;
    const end = doc.range ? doc.range.end : doc.pageCount;
    const isPhoto = !!doc.photoFiles;
    doc.pageRange = [start, end];
    doc.pages = [];   // 重建 DOM，重置页面渲染状态
    // 多图：按上传顺序拼接成一张长图（间距可调）
    if(doc.photoFiles && doc.photoFiles.length > 1){
      this.renderStitchDoc(doc);
      return;
    }
    const html = [];
    for(let i=start;i<=end;i++){
      html.push('<div class="pdf-page" data-page="'+i+'">'
        + '<div class="page-canvas-wrap">'
        +   '<canvas class="page-img" style="aspect-ratio:'+(isPhoto?'4/3':'595/842')+'"></canvas>'
        +   '<div class="page-overlays"></div>'
        + '</div>'
        + '<div class="page-label">'+(isPhoto ? '第 '+(i-start+1)+' 张图' : '第 '+i+' 页')+' · 按住左键拖拽框选区域识别文字</div>'
        + '</div>');
    }
    this.docEl.innerHTML = html.join('');
    this.applyZoom();
    // 首页立即开渲（不等 IntersectionObserver 回调，打开即见内容）
    {
      const firstEl = this.docEl.querySelector('.pdf-page');
      if(firstEl) this.enqueuePageRender(doc, +firstEl.dataset.page, firstEl);
    }
    if('IntersectionObserver' in window){
      if(this._imgObs) this._imgObs.disconnect();
      this._imgObs = new IntersectionObserver(entries=>{
        for(const en of entries){
          if(en.isIntersecting){
            const el = en.target;
            this.drawThumb(doc, +el.dataset.page, el);   // 速览图立即上屏
            const st = this.pageState(doc, +el.dataset.page);
            if(!st.rendered && !st.rendering) this.enqueuePageRender(doc, +el.dataset.page, el);
          }
        }
        this.gcPageImages(doc);
      }, {root: this.docEl, rootMargin: '900px 0px 900px 0px'});
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this._imgObs.observe(el));
    }else{
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this.renderPageImage(doc, +el.dataset.page, el));
    }
    this.startThumbs(doc);
  },

  /* 页面渲染队列：最多 3 页并发，跳过的任务直接丢弃 */
  enqueuePageRender(doc, pageNum, el){
    this._renderQueue.push({doc, pageNum, el});
    this.pumpRenderQueue();
  },

  pumpRenderQueue(){
    if(this._activeRenders >= 3 || !this._renderQueue.length) return;
    // 优先渲染离视口最近的页（拖进度条直达的页立即开工）
    const rootRect = this.docEl.getBoundingClientRect();
    let bestIdx = -1, bestDist = Infinity;
    this._renderQueue.forEach((job, i)=>{
      if(!job.el.isConnected || this.currentDoc()!==job.doc) return;
      const r = job.el.getBoundingClientRect();
      const dist = (r.bottom < rootRect.top) ? rootRect.top - r.bottom
                 : (r.top > rootRect.bottom) ? r.top - rootRect.bottom : 0;
      if(dist < bestDist){ bestDist = dist; bestIdx = i; }
    });
    if(bestIdx < 0 || bestDist > 2500){ this._renderQueue = []; return; }
    const job = this._renderQueue.splice(bestIdx, 1)[0];
    this._activeRenders++;
    this.renderPageImage(job.doc, job.pageNum, job.el).finally(()=>{
      this._activeRenders--;
      this.pumpRenderQueue();
    });
  },

  pageState(doc, pageNum){
    if(!doc.pages) doc.pages = [];
    if(!doc.pages[pageNum]) doc.pages[pageNum] = {rendered:false, rendering:false, overlays:[], ocrBusy:false, task:null};
    return doc.pages[pageNum];
  },

  async renderPageImage(doc, pageNum, el){
    if(doc.mode==='textview'){ return this.renderTextSegment(doc, pageNum, el); }
    if(doc.stitchSegs) return this.renderStitchSegment(doc, pageNum, el);
    if(doc.photoFiles) return this.renderPhoto(doc, pageNum, el);
    if(!doc.pdf && !doc.mupdfId) return;
    const st = this.pageState(doc, pageNum);
    if(st.rendered || st.rendering) return;
    st.rendering = true;
    try{
      if(doc.mupdfId && window.__mupdf){
        // 桌面版：MuPDF 主进程渲染，原生速度
        const r = await window.__mupdf.render(doc.mupdfId, pageNum, 1.5);
        if(!r || !r.ok || !r.png) throw new Error('MuPDF 渲染失败');
        const bmp = await createImageBitmap(new Blob([r.png], {type:'image/png'}));
        const canvas = el.querySelector('.page-img');
        canvas.width = bmp.width; canvas.height = bmp.height;
        canvas.style.aspectRatio = bmp.width + ' / ' + bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
      }else{
        const page = await doc.pdf.getPage(pageNum);
        const viewport = page.getViewport({scale: 1.5});
        const canvas = el.querySelector('.page-img');
        canvas.width = viewport.width; canvas.height = viewport.height;
        canvas.style.aspectRatio = viewport.width + ' / ' + viewport.height;
        const ctx = canvas.getContext('2d');
        const task = page.render({canvasContext: ctx, viewport});
        st.task = task;
        await task.promise;
        page.cleanup();
      }
      const canvas = el.querySelector('.page-img');
      st.rendered = true; st.rendering = false; st.task = null;
      canvas.classList.add('loaded');
      canvas.classList.remove('thumbed');
    }catch(e){
      if(!(e && e.name==='RenderingCancelledException')) console.error('页面渲染失败', pageNum, e);
      st.rendering = false; st.task = null;
    }
  },

  async renderPhoto(doc, pageNum, el){
    const st = this.pageState(doc, pageNum);
    if(st.rendered || st.rendering) return;
    st.rendering = true;    try{
      const f = doc.photoFiles[pageNum-1];
      const MAX = 2600;
      // 直接以目标尺寸解码，避免整张原图进入内存
      const dims = await imgDims(f);
      const scale = Math.min(1, MAX / Math.max(dims[0], dims[1]));
      const bmp = await createImageBitmap(f, {
        resizeWidth: Math.round(dims[0]*scale),
        resizeHeight: Math.round(dims[1]*scale)
      });
      const canvas = el.querySelector('.page-img');
      canvas.width = bmp.width; canvas.height = bmp.height;
      canvas.style.aspectRatio = bmp.width + ' / ' + bmp.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      st.rendered = true; st.rendering = false;
      canvas.classList.add('loaded');
    }catch(e){
      console.error('图片加载失败', pageNum, e);
      st.rendering = false;
    }
  },

  /* ---------- 多图拼接：按上传顺序拼成长图，间距可调 ---------- */
  async ensurePhotoMeta(doc){
    if(doc.photoMeta) return;
    doc.photoMeta = [];
    const MAX = 2600;
    for(const f of doc.photoFiles){
      try{
        // 限尺寸解码：大照片不再整张解码进内存（拼接画布宽 1600，2600 已足够清晰）
        const dims = await imgDims(f);
        const scale = Math.min(1, MAX / Math.max(dims[0], dims[1]));
        const bmp = await createImageBitmap(f, {
          resizeWidth: Math.round(dims[0]*scale),
          resizeHeight: Math.round(dims[1]*scale)
        });
        doc.photoMeta.push({bmp, w:bmp.width, h:bmp.height});
      }catch(e){
        console.error('图片解码失败', f.name, e);
      }
    }
  },

  async renderStitchDoc(doc){
    if(!doc.photoMeta){ await this.ensurePhotoMeta(doc); }
    if(doc !== this.currentDoc()) return;
    const gap = doc.photoGap!=null ? doc.photoGap : 8;
    const gp = document.getElementById('photoGap');
    if(gp && +gp.value !== gap) gp.value = gap;
    const gv = document.getElementById('photoGapVal');
    if(gv) gv.textContent = gap+'px';
    const W = 1600;
    const gapC = Math.round(gap * W / 760);
    const segs = [];
    let seg = {h:0, items:[]};
    for(const it of doc.photoMeta){
      const h = Math.round(W * it.h / it.w);
      const add = (seg.items.length ? gapC : 0) + h;
      if(seg.h + add > 8200 && seg.items.length){
        segs.push(seg);
        seg = {h:0, items:[]};
      }
      seg.h += add;
      seg.items.push(it);
    }
    if(seg.items.length) segs.push(seg);
    doc.stitchSegs = segs;
    doc.pages = [];   // 重建 DOM，重置页面渲染状态
    if(this._imgObs){ this._imgObs.disconnect(); this._imgObs = null; }
    this.docEl.innerHTML = segs.map((s,i)=>
      '<div class="pdf-page" data-page="'+(i+1)+'">'
      + '<div class="page-canvas-wrap">'
      + '<canvas class="page-img" style="aspect-ratio:'+W+'/'+s.h+'"></canvas>'
      + '<div class="page-overlays"></div>'
      + '</div>'
      + '<div class="page-label">拼接图 '+(i+1)+'/'+segs.length+' · 按住左键拖拽框选区域识别文字</div>'
      + '</div>').join('');
    this.applyZoom();
    if('IntersectionObserver' in window){
      this._imgObs = new IntersectionObserver(entries=>{
        for(const en of entries){
          if(en.isIntersecting){
            const el = en.target;
            const st = this.pageState(doc, +el.dataset.page);
            if(!st.rendered && !st.rendering) this.enqueuePageRender(doc, +el.dataset.page, el);
          }
        }
        this.gcPageImages(doc);
      }, {root: this.docEl, rootMargin: '900px 0px 900px 0px'});
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this._imgObs.observe(el));
    }
  },

  async renderStitchSegment(doc, segIdx, el){
    const seg = doc.stitchSegs[segIdx-1];
    if(!seg) return;
    const st = this.pageState(doc, segIdx);
    if(st.rendered || st.rendering) return;
    st.rendering = true;
    try{
      const W = 1600;
      const gap = doc.photoGap!=null ? doc.photoGap : 8;
      const gapC = Math.round(gap * W / 760);
      const canvas = el.querySelector('.page-img');
      canvas.width = W; canvas.height = seg.h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, seg.h);
      let y = 0;
      seg.items.forEach((it, i)=>{
        if(i > 0){
          y += gapC;
          // 可见的灰条分隔带 + 虚线，让间距调节一目了然
          ctx.fillStyle = '#eef0f4';
          ctx.fillRect(0, y-gapC, W, gapC);
          ctx.strokeStyle = '#c9cfdc';
          ctx.setLineDash([14, 12]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(60, y-gapC/2);
          ctx.lineTo(W-60, y-gapC/2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const h = Math.round(W * it.h / it.w);
        ctx.drawImage(it.bmp, 0, y, W, h);
        y += h;
      });
      canvas.style.aspectRatio = W + ' / ' + seg.h;
      st.rendered = true; st.rendering = false;
      canvas.classList.add('loaded');
    }catch(e){
      console.error('拼接图渲染失败', segIdx, e);
      st.rendering = false;
    }
  },

  gcPageImages(doc){
    const rootRect = this.docEl.getBoundingClientRect();
    const pages = [...this.docEl.querySelectorAll('.pdf-page')];
    const list = [];
    let rendered = 0;
    for(const el of pages){
      const st = this.pageState(doc, +el.dataset.page);
      if(!st.rendered && !st.rendering) continue;
      const r = el.getBoundingClientRect();
      const dist = (r.bottom < rootRect.top) ? rootRect.top - r.bottom
                 : (r.top > rootRect.bottom) ? r.top - rootRect.bottom : 0;
      if(st.rendering) list.push({el, st, dist, rendering:true});
      else{ rendered++; list.push({el, st, dist, rendering:false}); }
    }
    // 远处页：渲染中的取消任务，已渲染的释放画布
    for(const it of list){
      if(it.dist > 2500){
        if(it.rendering){
          if(it.st.task){ try{ it.st.task.cancel(); }catch(e){} it.st.task = null; }
          it.st.rendering = false;
        }else{
          this.freePageCanvas(it.el, it.st);
          rendered--;
        }
      }
    }
    // 超过保留上限时释放最远的（文本查看器画布更省着留）
    const keepMax = doc.mode==='textview' ? 4 : 12;
    if(rendered > keepMax){
      const rend = list.filter(x=>!x.rendering && x.st.rendered).sort((a,b)=>b.dist-a.dist);
      let need = rendered - keepMax;
      for(const it of rend){
        if(need <= 0) break;
        this.freePageCanvas(it.el, it.st);
        need--;
      }
    }
  },

  freePageCanvas(el, st){
    if(st.task){ try{ st.task.cancel(); }catch(e){} st.task = null; }
    const canvas = el.querySelector('.page-img');
    if(canvas){ canvas.width = canvas.height = 0; canvas.classList.remove('loaded'); canvas.classList.remove('thumbed'); }
    st.rendered = false;
    st.thumb = false;
  },

  /* ================= 手势 ================= */
  onDown(e){
    if(e.button!==0) return;
    const doc = this.currentDoc();
    if(!doc) return;
    if(this.docEl.classList.contains('selectable')) return; // 文本选择模式
    // 1) 识别覆盖层中的单词手势
    const span = e.target.closest('.ws-word');
    if(span){
      const overlayEl = e.target.closest('.pdf-overlay');
      if(overlayEl){
        e.preventDefault();
        const pageEl = e.target.closest('.pdf-page');
        const g = { kind:'word', doc, anchor:+span.dataset.i, cur:+span.dataset.i, mode:'pending',
                    startX:e.clientX, startY:e.clientY, prev:[0,0], spanEl:span, pageEl:pageEl||null,
                    overlayEl:overlayEl, blockEl:null, spans: overlayEl.spans };
        this.gesture = g;
        g.timer = setTimeout(()=>{
          if(this.gesture!==g) return;
          g.mode = 'selecting';
          this.applySel(g, g.anchor, g.anchor);
        }, 380);
        return;
      }
    }
    // 2) 查看器/扫描/拼接/文本页：区域框选手势
    if(doc.mode==='image' || doc.mode==='textview'){
      const pageEl = e.target.closest('.pdf-page');
      if(pageEl && !e.target.closest('.pdf-overlay')){
        e.preventDefault();
        const wrap = pageEl.querySelector('.page-canvas-wrap');
        const rect = wrap.getBoundingClientRect();
        const g = { kind:'region', doc, pageEl, wrap, mode:'pending',
                    startX:e.clientX, startY:e.clientY,
                    x0: e.clientX-rect.left, y0: e.clientY-rect.top,
                    curX: e.clientX-rect.left, curY: e.clientY-rect.top, selEl:null };
        this.gesture = g;
        g.timer = setTimeout(()=>{
          if(this.gesture!==g) return;
          g.mode = 'selecting';
          this.showSelRect(g);
        }, 380);
      }
    }
  },

  onMove(e){
    if(this.colDrag){
      const d = this.colDrag;
      if(d.side==='left'){
        App.state.wsLeftW = Math.round(Math.max(160, Math.min(d.startW + (e.clientX - d.startX), 560)));
      }else{
        App.state.wsRightW = Math.round(Math.max(240, Math.min(d.startW - (e.clientX - d.startX), 700)));
      }
      this.applyCols();
      return;
    }
    const g = this.gesture;
    if(!g) return;
    if(g.kind==='region'){
      if(g.mode!=='selecting') return;
      const rect = g.wrap.getBoundingClientRect();
      g.curX = Math.max(0, Math.min(e.clientX-rect.left, g.wrap.clientWidth));
      g.curY = Math.max(0, Math.min(e.clientY-rect.top, g.wrap.clientHeight));
      this.updateSelRect(g);
      const r = this.docEl.getBoundingClientRect();
      if(e.clientY < r.top+46) this.docEl.scrollTop -= 26;
      else if(e.clientY > r.bottom-46) this.docEl.scrollTop += 26;
      return;
    }
    if(g.mode!=='selecting') return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const span = el && el.closest ? el.closest('.ws-word') : null;
    if(span && g.overlayEl && span.closest('.pdf-overlay')!==g.overlayEl) return;
    if(span && g.blockEl && span.closest('.ws-block')!==g.blockEl) return;
    const idx = span && span.dataset.i!=null ? +span.dataset.i : g.cur;
    if(idx!==g.cur){ g.cur = idx; this.applySel(g, g.anchor, g.cur); }
    const r = this.docEl.getBoundingClientRect();
    if(e.clientY < r.top+46) this.docEl.scrollTop -= 26;
    else if(e.clientY > r.bottom-46) this.docEl.scrollTop += 26;
  },

  onUp(e){
    if(this.colDrag){
      this.colDrag = null;
      document.getElementById('wsLeftHandle').classList.remove('active');
      document.getElementById('wsRightHandle').classList.remove('active');
      App.save();
      return;
    }
    const g = this.gesture;
    if(!g) return;
    this.gesture = null;
    clearTimeout(g.timer);
    if(g.kind==='region'){
      if(g.selEl){ g.selEl.remove(); }
      if(g.mode!=='selecting'){
        if(!this._hintShown){ this._hintShown = true; App.toast('扫描模式：按住左键约 0.4 秒后拖拽，框选要识别的文字区域'); }
        return;
      }
      const w = Math.abs(g.curX - g.x0), h = Math.abs(g.curY - g.y0);
      if(w < 12 || h < 12) return;
      const x = Math.min(g.x0, g.curX), y = Math.min(g.y0, g.curY);
      this.ocrRegion(g.doc, g.pageEl, {x, y, w, h});
      return;
    }
    // 单词手势
    if(g.mode==='pending'){
      if(g.spanEl) this.onWordClick(g.doc, g.spanEl, e, g.pageEl);
      return;
    }
    const a = Math.min(g.anchor, g.cur), b = Math.max(g.anchor, g.cur);
    this.clearSel(g);
    const spans = g.spans || g.doc.spans;
    const words = spans.slice(a, b+1).map(s=>s.textContent.trim()).filter(Boolean);
    if(!words.length) return;
    if(words.length===1){ this.onWordClick(g.doc, spans[a], e, g.pageEl); return; }
    this.showPhrasePopup(words.join(' '), e);
  },

  showSelRect(g){
    let r = g.wrap.querySelector('.pdf-selrect');
    if(!r){
      r = document.createElement('div');
      r.className = 'pdf-selrect';
      g.wrap.appendChild(r);
    }
    g.selEl = r;
    this.updateSelRect(g);
  },

  updateSelRect(g){
    const x = Math.min(g.x0, g.curX), y = Math.min(g.y0, g.curY);
    g.selEl.style.left = x+'px';
    g.selEl.style.top = y+'px';
    g.selEl.style.width = Math.abs(g.curX - g.x0)+'px';
    g.selEl.style.height = Math.abs(g.curY - g.y0)+'px';
  },

  applySel(g, a, b){
    const [x,y] = [Math.min(a,b), Math.max(a,b)];
    const spans = g.spans || g.doc.spans;
    for(let i=g.prev[0]; i<=g.prev[1] && i<spans.length; i++) if(i<x||i>y) spans[i].classList.remove('sel');
    for(let i=x; i<=y; i++) spans[i].classList.add('sel');
    g.prev = [x,y];
  },

  clearSel(g){
    const spans = g.spans || g.doc.spans;
    for(let i=g.prev[0]; i<=g.prev[1] && i<spans.length; i++) spans[i].classList.remove('sel');
  },

  onWordClick(doc, spanEl, e, pageEl){
    if(pageEl){
      // 扫描模式识别覆盖层中的单词：标黄仅作视觉标记
      spanEl.classList.add('marked');
    }else{
      const gi = spanEl.dataset.gi!=null ? +spanEl.dataset.gi : null;
      if(gi!=null && !doc.marks.has(gi)){
        doc.marks.add(gi);
        spanEl.classList.add('marked');
        this.persistMarks(doc);
      }
    }
    const entry = App.dictLookup(spanEl.textContent);
    this.showWordPopup(spanEl.textContent, entry, e, doc, spanEl.dataset.gi!=null ? +spanEl.dataset.gi : null, spanEl, !!pageEl);
  },

  /* ================= 区域 OCR ================= */
  getOcrWorker(){
    if(this._ocrWorker) return Promise.resolve(this._ocrWorker);
    if(!this._ocrWorkerPromise){
      this._ocrWorkerPromise = ensureTesseract()
        .then(()=>Tesseract.createWorker('eng+chi_sim', 1, {
          workerPath: location.origin + '/libs/tess/worker.min.js',
          corePath: location.origin + '/libs/tess/tesseract-core-simd.wasm.js',
          langPath: location.origin + '/tessdata/',
          gzip: false
        }))
        .then(w=>{ this._ocrWorker = w; return w; })
        .catch(e=>{ this._ocrWorkerPromise = null; throw new Error('OCR 引擎初始化失败：'+(e&&e.message||e)); });
    }
    return this._ocrWorkerPromise;
  },

  async ocrRegion(doc, pageEl, rectCss){
    const pageNum = +pageEl.dataset.page;
    const st = this.pageState(doc, pageNum);
    if(st.ocrBusy){ App.toast('该页已有区域正在识别中…'); return; }
    const canvas = pageEl.querySelector('.page-img');
    if(!st.rendered || !canvas.width){ App.toast('页面尚未渲染完成，请稍后再试','err'); return; }
    st.ocrBusy = true;
    App.toast('正在识别所选区域文字…');
    try{
      const worker = await this.getOcrWorker();
      const cw = canvas.width, ch = canvas.height;
      const cr = canvas.getBoundingClientRect();
      const sx = cw / cr.width, sy = ch / cr.height;
      let x = Math.floor(rectCss.x * sx), y = Math.floor(rectCss.y * sy);
      let w = Math.max(1, Math.ceil(rectCss.w * sx)), h = Math.max(1, Math.ceil(rectCss.h * sy));
      x = Math.max(0, Math.min(x, cw-1)); y = Math.max(0, Math.min(y, ch-1));
      w = Math.min(w, cw-x); h = Math.min(h, ch-y);
      const UP = Math.min(4, Math.sqrt((2000*1500) / Math.max(1, w*h)));   // 超大区域自适应缩放，控制 OCR 耗时
      const t = document.createElement('canvas');
      t.width = Math.max(1, Math.round(w*UP)); t.height = Math.max(1, Math.round(h*UP));
      const tctx = t.getContext('2d');
      tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
      tctx.fillStyle = '#fff'; tctx.fillRect(0,0,t.width,t.height);
      tctx.drawImage(canvas, x, y, w, h, 0, 0, t.width, t.height);
      const res = await worker.recognize(t);
      const text = String((res && res.data && res.data.text)||'').trim();
      t.width = t.height = 0;
      if(!text){ App.toast('未识别到文字，请框选更清晰的文字区域','err'); return; }
      this.addOverlay(doc, pageEl, rectCss, text, st);
      App.toast('识别完成，可点击其中的单词查看释义');
    }catch(e){
      console.error(e);
      App.toast('区域识别失败：'+(e&&e.message||e),'err');
    }finally{
      st.ocrBusy = false;
    }
  },

  addOverlay(doc, pageEl, rectCss, text, st){
    const ov = document.createElement('div');
    ov.className = 'pdf-overlay';
    ov.style.left = rectCss.x+'px';
    ov.style.top = rectCss.y+'px';
    ov.style.width = Math.max(rectCss.w, 140)+'px';
    ov.style.minHeight = Math.max(rectCss.h, 24)+'px';
    ov.innerHTML = '<div class="pdf-overlay-bar"><span class="pdf-overlay-tag">已识别</span>'
      + '<button class="ov-act" data-ov="collect" title="把这段文字和释义收录到记忆区">📥 收录全部</button>'
      + '<button class="ov-act" data-ov="close" title="移除该识别框">✕</button></div>'
      + '<div class="pdf-overlay-text">'+this.buildHTML(text)+'</div>';
    pageEl.querySelector('.page-overlays').appendChild(ov);
    ov.spans = [...ov.querySelectorAll('.ws-word')];
    st.overlays.push(ov);
    ov.querySelectorAll('[data-ov]').forEach(b=>{
      b.addEventListener('click', ()=>{
        if(b.dataset.ov==='close'){
          ov.remove();
          st.overlays = st.overlays.filter(x=>x!==ov);
          return;
        }
        if(b.dataset.ov==='collect'){
          const lines = text.split(/\s+/).filter(Boolean).slice(0, 80).map(w=>{
            const en = App.dictLookup(w);
            return w + (en ? ' — '+(en.defs[0]||'') : '');
          }).join('\n');
          MEM.add(text.slice(0, 2000), lines || '');
          App.toast('已收录所选区域文字到记忆区');
        }
      });
    });
  },

  /* ================= 标黄持久化 ================= */
  loadAllMarks(){ try{ return JSON.parse(localStorage.getItem('kyw_marks_v1')||'{}'); }catch(e){ return {}; } },
  loadMarks(id){ const s = this.loadAllMarks(); return new Set((s[id]||[]).map(Number)); },
  persistMarks(doc){
    const store = this.loadAllMarks();
    if(doc.marks.size) store[doc.id] = [...doc.marks];
    else delete store[doc.id];
    localStorage.setItem('kyw_marks_v1', JSON.stringify(store));
  },

  async clearMarks(){
    const doc = this.currentDoc();
    if(!doc || doc.mode==='image'){ App.toast(doc && doc.mode==='image' ? '扫描模式下无持久标黄，可直接关闭识别框' : '当前没有文档'); return; }
    if(!doc.marks.size){ App.toast('当前文档没有标黄单词'); return; }
    if(!(await App.confirm('清除当前文档全部 '+doc.marks.size+' 个标黄单词？'))) return;
    doc.marks.clear();
    this.docEl.querySelectorAll('.ws-word.marked').forEach(s=>s.classList.remove('marked'));
    this.persistMarks(doc);
    App.toast('已清除当前文档的标黄');
  },

  /* ================= 右侧释义面板 ================= */
  renderDef(html, ctx){
    this.popupCtx = ctx;
    this.defEl.innerHTML = html;
    this.defEl.querySelectorAll('[data-act]').forEach(b=>{
      b.addEventListener('click', ()=>this.popupAction(b.dataset.act));
    });
  },

  resetDef(){
    this.popupCtx = null;
    this.defEl.innerHTML = '<div class="ws-def-empty"><div class="empty small">💡 单击单词查看考研释义<br><span class="empty-sub">扫描模式：长按拖拽框选区域识别文字</span></div></div>';
  },

  popupAction(act){
    const ctx = this.popupCtx;
    if(!ctx) return;
    if(act==='close'){ this.resetDef(); return; }
    if(act==='collect'){
      let meaning = '';
      if(ctx.isPhrase){
        if(ctx.onlineSenses && ctx.onlineSenses.length){
          meaning = ctx.onlineSenses.join('\n');
        }else{
          meaning = ctx.words.map(w=>{
            const en = App.dictLookup(w);
            return w + (en ? ' — '+(en.defs[0]||'') : '（未收录）');
          }).join('\n');
        }
      }else{
        if(ctx.entry) meaning = ctx.entry.defs.join('\n');
        if(ctx.onlineSenses && ctx.onlineSenses.length){
          meaning = meaning ? meaning+'\n【在线】'+ctx.onlineSenses.join('\n') : ctx.onlineSenses.join('\n');
        }
      }
      if(!meaning) meaning = '（无释义，可在记忆区自行编辑补充）';
      MEM.add(ctx.text, meaning);
      App.toast('已收录「'+ctx.text+'」到记忆区');
      return;
    }
    if(act==='toggleMark'){
      if(!ctx.doc || !ctx.spanEl){ return; }
      let marked;
      if(ctx.overlay){
        marked = ctx.spanEl.classList.toggle('marked');
      }else{
        const {doc, gi, spanEl} = ctx;
        if(gi==null) return;
        if(doc.marks.has(gi)){ doc.marks.delete(gi); spanEl.classList.remove('marked'); marked=false; }
        else{ doc.marks.add(gi); spanEl.classList.add('marked'); marked=true; }
        this.persistMarks(doc);
      }
      const b = this.defEl.querySelector('[data-act="toggleMark"]');
      if(b) b.textContent = marked ? '取消标黄' : '标黄';
      return;
    }
    if(act==='dict'){
      App.switchTab('dict');
      document.getElementById('dictInput').value = ctx.text;
      DICT.search(ctx.text);
      return;
    }
  },

  showWordPopup(word, entry, e, doc, idx, spanEl, overlay){
    const marked = spanEl ? spanEl.classList.contains('marked') : false;
    let fam;
    if(entry){
      const clean = String(word||'').toLowerCase().replace(/[^a-z]/g,'');
      if(clean && clean !== entry.w.toLowerCase()){
        // 点击的是派生形式（moves→move）：原形排到词群第一位，可直接收录
        fam = [entry, ...App.dictFamily(entry.w, 9)];
      }else{
        fam = App.dictFamily(entry.w, 10);
      }
    }else{
      fam = App.dictFamily(String(word||''), 10);
    }
    const ctx = { text:word, entry, isPhrase:false, doc, idx, gi: idx, spanEl, overlay,
                  onlineSenses:null, onlinePhon:'' };
    this.renderDef(this.popupWordHTML(word, entry, marked, fam, !!doc), ctx);
    this.bindFamActions();
    if(App.state.source==='youdao') this.fillOnline(ctx, word);
  },

  /* 词群成员点击 → 直接切换查看该词 */
  showWordLookup(w){
    const entry = App.dictLookup(w);
    const fam = App.dictFamily(w, 10);
    const ctx = { text:w, entry, isPhrase:false, doc:null, idx:null, spanEl:null, overlay:false,
                  onlineSenses:null, onlinePhon:'' };
    this.renderDef(this.popupWordHTML(w, entry, false, fam, false), ctx);
    this.bindFamActions();
    if(App.state.source==='youdao') this.fillOnline(ctx, w);
  },

  bindFamActions(){
    this.defEl.querySelectorAll('[data-fam]').forEach(row=>{
      row.addEventListener('click', e=>{
        if(e.target.closest('[data-fam-add]')) return;
        this.showWordLookup(row.dataset.fam);
      });
    });
    this.defEl.querySelectorAll('[data-fam-add]').forEach(b=>{
      b.addEventListener('click', e=>{
        e.stopPropagation();
        const w = b.dataset.famAdd;
        const en = App.dictLookup(w);
        MEM.add(w, en ? en.defs.join('\n') : '');
        App.toast('已收录「'+w+'」到记忆区');
      });
    });
  },

  showPhrasePopup(phrase, e){
    const words = phrase.split(/\s+/).filter(Boolean);
    const ctx = { text:phrase, isPhrase:true, words, onlineSenses:null, onlinePhon:'' };
    this.renderDef(this.popupPhraseHTML(phrase, words), ctx);
    if(App.state.source==='youdao') this.fillOnline(ctx, phrase);
  },

  fillOnline(ctx, q){
    const sec = this.defEl.querySelector('#onlineSec');
    const title = this.defEl.querySelector('#onlineTitle');
    if(!sec) return;
    if(title) title.style.display = 'block';
    sec.innerHTML = '<span class="spin"></span>查询在线词典…';
    App.fetchOnline(q).then(res=>{
      if(this.popupCtx!==ctx) return;
      ctx.onlineSenses = res.senses; ctx.onlinePhon = res.phonetic;
      if(title) title.textContent = '在线释义 · '+(res.source==='bing' ? '必应' : '有道');
      if(res.error){ sec.innerHTML = '<div class="note-line">在线查询失败：'+App.esc(res.error)+'</div>'; return; }
      if(res.senses.length){ sec.innerHTML = res.senses.map(s=>'<div class="def-line">'+App.esc(s)+'</div>').join(''); }
      else sec.innerHTML = '<div class="note-line">在线词典无结果</div>';
    });
  },

  popupWordHTML(word, entry, marked, fam, showMark){
    const chips = [];
    if(entry){
      if(entry.p) chips.push('<span class="popup-phon">'+App.esc(entry.p)+'</span>');
      if(entry.freq!=null) chips.push('<span class="chip">考研大纲词</span>');
      if(entry.cat) chips.push('<span class="chip gray">'+App.esc(entry.cat)+'</span>');
    }
    let body;
    if(entry){
      body = '<div class="origin-line">原形：<b>'+App.esc(entry.w)+'</b>'
           + (entry.fromWord ? '（点选的是其变化形式）' : '') + '</div>'
           + entry.defs.map(d=>'<div class="def-line">'+App.esc(d)+'</div>').join('');
    }else{
      body = '<div class="def-line note-line">未收录在考研词库中'+(App.state.source==='offline'?'，可切换顶栏词库来源为「有道词典（在线）」':'')+'</div>';
    }
    if(fam && fam.length){
      body += '<div class="popup-section-title">词群释义（'+fam.length+'，点击查看 / 📥 收录）</div><div class="fam-list">'
        + fam.map(f=>{
            const isBase = entry && f.w.toLowerCase()===entry.w.toLowerCase();
            return '<div class="fam-row" data-fam="'+App.esc(f.w)+'" title="点击查看该词释义">'
              + (isBase ? '<span class="chip gray">原形</span>' : '')
              + '<span class="fam-word">'+App.esc(f.w)+'</span>'
              + (f.p?'<span class="popup-phon">'+App.esc(f.p)+'</span>':'')
              + '<span class="fam-def">'+App.esc(f.defs[0]||'')+'</span>'
              + '<button class="fam-add" data-fam-add="'+App.esc(f.w)+'" title="收录到记忆区">📥</button>'
              + '</div>';
          }).join('') + '</div>';
    }
    body += '<div class="popup-section-title" id="onlineTitle"'+(App.state.source!=='youdao'?' style="display:none"':'')+'>在线释义</div><div id="onlineSec"></div>';
    return `<button class="popup-close" data-act="close" title="关闭">✕</button>
    <div class="popup-head"><span class="popup-word">${App.esc(word)}</span>${chips.join('')}</div>
    <div class="popup-body">${body}</div>
    <div class="popup-foot">
      <button class="btn btn-primary" data-act="collect">📥 收录到记忆区</button>
      ${showMark ? '<button class="btn btn-ghost" data-act="toggleMark">'+(marked?'取消标黄':'标黄')+'</button>' : ''}
      <button class="btn btn-ghost" data-act="dict">词典中打开</button>
    </div>`;
  },

  popupPhraseHTML(phrase, words){
    const breakdown = words.map(w=>{
      const en = App.dictLookup(w);
      return '<div class="def-line"><b>'+App.esc(w)+'</b> — '+App.esc(en?(en.defs[0]||''):'未收录')+'</div>';
    }).join('');
    return `<button class="popup-close" data-act="close" title="关闭">✕</button>
    <div class="popup-head"><span class="popup-word">${App.esc(phrase)}</span><span class="chip">词组 · ${words.length} 词</span></div>
    <div class="popup-body">
      <div class="popup-section-title" style="border-top:0;margin-top:0;padding-top:0">逐词释义</div>
      ${breakdown}
      <div class="popup-section-title" id="onlineTitle"${App.state.source!=='youdao'?' style="display:none"':''}>在线释义</div>
      <div id="onlineSec"></div>
    </div>
    <div class="popup-foot">
      <button class="btn btn-primary" data-act="collect">📥 收录词组</button>
      <button class="btn btn-ghost" data-act="dict">词典中查询</button>
    </div>`;
  },

  /* ================= 文本渲染 ================= */
  buildHTML(text){
    const parts = [];
    const re = /[A-Za-z]+(?:['’\-][A-Za-z]+)*/g;
    let last = 0, m, n = 0;
    while((m = re.exec(text))){
      if(m.index > last) parts.push(App.esc(text.slice(last, m.index)));
      parts.push('<span class="ws-word" data-i="'+(n++)+'">'+App.esc(m[0])+'</span>');
      last = m.index + m[0].length;
    }
    if(last < text.length) parts.push(App.esc(text.slice(last)));
    return parts.join('');
  }
};

function countWords(text){ let n=0; const re=/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g; while(re.exec(text)) n++; return n; }

/* 只取图片原始尺寸（不触发完整解码） */
function imgDims(file){
  return new Promise((res, rej)=>{
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = ()=>{ URL.revokeObjectURL(url); res([im.naturalWidth, im.naturalHeight]); };
    im.onerror = ()=>{ URL.revokeObjectURL(url); rej(new Error('图片解码失败')); };
    im.src = url;
  });
}

/* 按段落分块：每块约 1.2 万字符，超大段落硬切，块间不切词 */
function splitBlocks(text){
  const paras = String(text).split(/(?:\r?\n){2,}/);
  const blocks = [];
  let cur = '';
  for(const p of paras){
    cur = cur ? cur+'\n\n'+p : p;
    if(cur.length >= 12000){ blocks.push(cur); cur = ''; }
  }
  if(cur) blocks.push(cur);
  const out = [];
  for(const b of blocks){
    if(b.length <= 24000){ out.push(b); continue; }
    let rest = b;
    while(rest.length > 24000){
      let cut = 24000;
      const nl = rest.lastIndexOf('\n', 24000);
      if(nl > 12000) cut = nl;
      else{
        const sp = rest.lastIndexOf(' ', 24000);
        if(sp > 12000) cut = sp;
      }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if(rest) out.push(rest);
  }
  return out;
}
