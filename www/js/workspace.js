'use strict';
/* ============ 工作区：文本模式（可点击单词）+ 扫描模式（图片显示 + 区域OCR识别） ============ */
const WS_EMPTY = '<div class="empty">📄 上传资料后，这里将显示可点击识别的英文<br><span class="empty-sub">单击查释义并标黄 · 长按拖拽框选词组 · 扫描版长按拖选区域识别文字</span></div>';

function djb2(s){ let h=5381; for(let i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))>>>0; return h; }

const WS = {
  docs: [], activeId: null, gesture: null,
  defEl: null, popupCtx: null,
  _imgObs: null,
  _ocrWorker: null, _ocrWorkerPromise: null,
  _hintShown: false,

  init(){
    if(window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
    this.defEl = document.getElementById('wsDef');
    this.docEl = document.getElementById('wsDoc');
    document.getElementById('btnUpload').addEventListener('click', ()=>document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', e=>{ this.handleFiles([...e.target.files]); e.target.value=''; });
    // 拖拽上传
    const drop = this.docEl;
    drop.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', ()=>drop.classList.remove('dragover'));
    drop.addEventListener('drop', e=>{ e.preventDefault(); drop.classList.remove('dragover'); this.handleFiles([...e.dataTransfer.files]); });
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
    if(doc && doc.mode==='image'){
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
          doc.pageCount = parsed.pageCount;
          doc.range = parsed.range;
          doc.pages = [];
          doc.text = '';
          doc.status = null;
          this.renderDocList();
          this.activateDoc(doc.id);
          App.toast('已以扫描模式打开（'+parsed.pageCount+' 页）：按住左键拖拽框选文字区域即可识别');
        }else{
          let text = parsed.text;
          if(!text.trim()){
            this.removeDocSilent(doc.id);
            App.toast('未提取到文字内容：'+f.name,'err');
            continue;
          }
          if(text.length > 3000000){
            text = text.slice(0, 3000000);
            App.toast('内容过长，已截断前 300 万字符；其余部分可用页码范围再解析');
          }
          doc.text = text; doc.html = null; doc.status = null;
          this.renderDocList();
          this.activateDoc(doc.id);
          App.toast(doc.spans.length
            ? '已加载：'+f.name+'（约 '+doc.spans.length+' 个可识别单词）'
            : '已加载：'+f.name+'，但未发现英文单词','err');
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
    if(ext==='docx'||ext==='doc') return this.parseDocx(file).then(text=>({mode:'text', text}));
    return this.parseText(file).then(text=>({mode:'text', text}));
  },

  async parseText(file){
    const buf = await file.arrayBuffer();
    try{ return new TextDecoder('utf-8',{fatal:true}).decode(buf); }
    catch(e){ return new TextDecoder('gb18030').decode(buf); }
  },

  async parseDocx(file){
    if(!window.mammoth) throw new Error('Word 解析组件未加载');
    try{
      const arrayBuffer = await file.arrayBuffer();
      const res = await mammoth.extractRawText({arrayBuffer});
      return res.value;
    }catch(e){ throw new Error('无法解析（旧版 .doc 请先用 WPS/Word 另存为 .docx）'); }
  },

  async parsePDF(file, opts){
    if(!window.pdfjsLib) throw new Error('PDF 解析组件未加载');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
    const total = pdf.numPages;
    let start = 1, end = total;

    if(total > 300){
      const ans = prompt('该 PDF 共 '+total+' 页。\n\n直接点「确定」= 打开全部；\n也可输入页码范围（如 120-180）只打开部分：','');
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

    const span = end - start + 1;
    const pages = [];
    let emptyRun = 0;
    for(let i=start;i<=end;i++){
      if(opts && opts.isCancelled && opts.isCancelled()) throw new Error('已取消');
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const hasText = tc.items.some(it => it.str && it.str.trim());
      // 起始连续 5 页都无文字 → 判定为扫描版，进入图片模式
      if(i - start < 5){
        if(!hasText) emptyRun++;
        if(i - start === 4 && emptyRun === 5){
          return {mode:'image', pdf, pageCount: total, range:{start, end}};
        }
      }
      const lines = []; let curY = null; let line = '';
      const flush = ()=>{ if(line){ lines.push(line); line=''; } };
      for(const it of tc.items){
        if(!it.str) continue;
        const y = it.transform ? it.transform[5] : 0;
        if(curY===null || Math.abs(y-curY)>2){ flush(); curY=y; line=it.str; }
        else if(it.hasEOL){ line += it.str; flush(); curY=null; }
        else line += (line && !/[- ]$/.test(line) && !/^[- ]/.test(it.str) ? ' ' : '') + it.str;
      }
      flush();
      pages.push(lines.join('\n'));
      page.cleanup();
      const done = i - start + 1;
      if(opts && opts.onProgress) opts.onProgress('解析中 '+done+'/'+span, done/span);
      if(span > 20 && (done % 10 === 0 || done === span)) App.toast('解析 PDF 中… '+done+'/'+span+' 页');
    }
    if(!pages.join('\n').trim()) return {mode:'image', pdf, pageCount: total, range:{start, end}};
    if(end < total) pages.push('……（共 '+total+' 页，本段解析第 '+start+'-'+end+' 页）');
    return {mode:'text', text: pages.join('\n\n')};
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

  removeDoc(id){
    const doc = this.docs.find(d=>d.id===id);
    if(!doc) return;
    if(doc.marks.size && !confirm('移除文档「'+doc.name+'」？该文档的标黄记录将被清除。')) return;
    this.removeDocSilent(id);
  },

  removeDocSilent(id){
    const doc = this.docs.find(d=>d.id===id);
    this.docs = this.docs.filter(d=>d.id!==id);
    const store = this.loadAllMarks(); delete store[id];
    localStorage.setItem('kyw_marks_v1', JSON.stringify(store));
    if(doc && doc.pdf){ try{ doc.pdf.destroy(); }catch(e){} }
    if(this._imgObs){ this._imgObs.disconnect(); this._imgObs = null; }
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
    if(!doc){ this.docEl.innerHTML = WS_EMPTY; return; }
    if(doc.mode==='image'){ this.renderImageDoc(doc); return; }
    if(!doc.html) doc.html = this.buildHTML(doc.text);
    this.docEl.innerHTML = doc.html;
    doc.spans = [...this.docEl.querySelectorAll('.ws-word')];
    doc.spans.forEach((s,i)=>{ if(doc.marks.has(i)) s.classList.add('marked'); });
    this.applyZoom();
  },

  /* ================= 扫描模式：图片显示 + 区域OCR ================= */
  renderImageDoc(doc){
    const start = doc.range ? doc.range.start : 1;
    const end = doc.range ? doc.range.end : doc.pageCount;
    const isPhoto = !!doc.photoFiles;
    doc.pageRange = [start, end];
    const html = [];
    for(let i=start;i<=end;i++){
      html.push('<div class="pdf-page" data-page="'+i+'">'
        + '<div class="page-canvas-wrap">'
        +   '<canvas class="page-img"></canvas>'
        +   '<div class="page-overlays"></div>'
        + '</div>'
        + '<div class="page-label">'+(isPhoto ? '第 '+(i-start+1)+' 张图' : '第 '+i+' 页')+' · 按住左键拖拽框选区域识别文字</div>'
        + '</div>');
    }
    this.docEl.innerHTML = html.join('');
    this.applyZoom();
    if('IntersectionObserver' in window){
      if(this._imgObs) this._imgObs.disconnect();
      this._imgObs = new IntersectionObserver(entries=>{
        let changed = false;
        for(const en of entries){
          if(en.isIntersecting){
            const el = en.target;
            if(!this.pageState(doc, +el.dataset.page).rendered){ this.renderPageImage(doc, +el.dataset.page, el); changed = true; }
          }
        }
        if(changed) this.gcPageImages(doc);
      }, {root: this.docEl, rootMargin: '900px 0px 900px 0px'});
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this._imgObs.observe(el));
    }else{
      this.docEl.querySelectorAll('.pdf-page').forEach(el=>this.renderPageImage(doc, +el.dataset.page, el));
    }
  },

  pageState(doc, pageNum){
    if(!doc.pages) doc.pages = [];
    if(!doc.pages[pageNum]) doc.pages[pageNum] = {rendered:false, rendering:false, overlays:[], ocrBusy:false};
    return doc.pages[pageNum];
  },

  async renderPageImage(doc, pageNum, el){
    if(doc.photoFiles) return this.renderPhoto(doc, pageNum, el);
    if(!doc.pdf) return;
    const st = this.pageState(doc, pageNum);
    if(st.rendered || st.rendering) return;
    st.rendering = true;
    try{
      const page = await doc.pdf.getPage(pageNum);
      const viewport = page.getViewport({scale: 3});
      const canvas = el.querySelector('.page-img');
      canvas.width = viewport.width; canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({canvasContext: ctx, viewport}).promise;
      page.cleanup();
      st.rendered = true; st.rendering = false;
      canvas.classList.add('loaded');
    }catch(e){
      console.error('页面渲染失败', pageNum, e);
      st.rendering = false;
    }
  },

  async renderPhoto(doc, pageNum, el){
    const st = this.pageState(doc, pageNum);
    if(st.rendered || st.rendering) return;
    st.rendering = true;
    try{
      const f = doc.photoFiles[pageNum-1];
      const url = URL.createObjectURL(f);
      const img = await new Promise((res, rej)=>{
        const im = new Image();
        im.onload = ()=>res(im);
        im.onerror = ()=>rej(new Error('图片解码失败'));
        im.src = url;
      });
      const MAX = 2600;
      const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = el.querySelector('.page-img');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      st.rendered = true; st.rendering = false;
      canvas.classList.add('loaded');
    }catch(e){
      console.error('图片加载失败', pageNum, e);
      st.rendering = false;
    }
  },

  gcPageImages(doc){
    const rootRect = this.docEl.getBoundingClientRect();
    const pages = [...this.docEl.querySelectorAll('.pdf-page')];
    let rendered = 0;
    const renderedList = [];
    for(const el of pages){
      const st = this.pageState(doc, +el.dataset.page);
      if(!st.rendered) continue;
      const r = el.getBoundingClientRect();
      const dist = (r.bottom < rootRect.top) ? rootRect.top - r.bottom
                 : (r.top > rootRect.bottom) ? r.top - rootRect.bottom : 0;
      rendered++;
      renderedList.push({el, st, dist});
    }
    // 距视口超过 2500px 的直接释放
    for(const it of renderedList){
      if(it.dist > 2500){ this.freePageCanvas(it.el, it.st); rendered--; }
    }
    // 超过 12 页时释放最远的
    if(rendered > 12){
      renderedList.sort((a,b)=>b.dist-a.dist);
      let need = rendered - 12;
      for(const it of renderedList){
        if(need <= 0) break;
        if(!it.st.rendered) continue;
        this.freePageCanvas(it.el, it.st);
        need--;
      }
    }
  },

  freePageCanvas(el, st){
    const canvas = el.querySelector('.page-img');
    if(canvas){ canvas.width = canvas.height = 0; canvas.classList.remove('loaded'); }
    st.rendered = false;
  },

  /* ================= 手势 ================= */
  onDown(e){
    if(e.button!==0) return;
    const doc = this.currentDoc();
    if(!doc) return;
    if(this.docEl.classList.contains('selectable')) return; // 文本选择模式
    // 1) 单词手势（文本模式或扫描模式识别覆盖层中的单词）
    const span = e.target.closest('.ws-word');
    if(span){
      e.preventDefault();
      const pageEl = e.target.closest('.pdf-page');
      const overlayEl = e.target.closest('.pdf-overlay');
      const g = { kind:'word', doc, anchor:+span.dataset.i, cur:+span.dataset.i, mode:'pending',
                  startX:e.clientX, startY:e.clientY, prev:[0,0], spanEl:span, pageEl:pageEl||null,
                  overlayEl:overlayEl||null, spans: overlayEl ? overlayEl.spans : null };
      this.gesture = g;
      g.timer = setTimeout(()=>{
        if(this.gesture!==g) return;
        g.mode = 'selecting';
        this.applySel(g, g.anchor, g.anchor);
      }, 380);
      return;
    }
    // 2) 扫描模式：区域框选手势
    if(doc.mode==='image'){
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
      const idx = +spanEl.dataset.i;
      if(!doc.marks.has(idx)){
        doc.marks.add(idx);
        spanEl.classList.add('marked');
        this.persistMarks(doc);
      }
    }
    const entry = App.dictLookup(spanEl.textContent);
    this.showWordPopup(spanEl.textContent, entry, e, doc, pageEl ? null : +spanEl.dataset.i, spanEl, !!pageEl);
  },

  /* ================= 区域 OCR ================= */
  getOcrWorker(){
    if(this._ocrWorker) return Promise.resolve(this._ocrWorker);
    if(!this._ocrWorkerPromise){
      this._ocrWorkerPromise = Tesseract.createWorker('eng+chi_sim', 1, {
        workerPath: '/libs/tess/worker.min.js',
        corePath: '/libs/tess/tesseract-core-simd.wasm.js',
        langPath: '/tessdata/',
        gzip: false
      }).then(w=>{ this._ocrWorker = w; return w; })
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
      const UP = 2;
      const t = document.createElement('canvas');
      t.width = w*UP; t.height = h*UP;
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

  clearMarks(){
    const doc = this.currentDoc();
    if(!doc || doc.mode==='image'){ App.toast(doc && doc.mode==='image' ? '扫描模式下无持久标黄，可直接关闭识别框' : '当前没有文档'); return; }
    if(!doc.marks.size){ App.toast('当前文档没有标黄单词'); return; }
    if(!confirm('清除当前文档全部 '+doc.marks.size+' 个标黄单词？')) return;
    doc.marks.clear();
    doc.spans.forEach(s=>s.classList.remove('marked'));
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
        const {doc, idx} = ctx;
        const span = doc.spans[idx];
        if(doc.marks.has(idx)){ doc.marks.delete(idx); span.classList.remove('marked'); marked=false; }
        else{ doc.marks.add(idx); span.classList.add('marked'); marked=true; }
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
    const marked = overlay ? spanEl.classList.contains('marked') : (doc ? doc.marks.has(idx) : false);
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
    const ctx = { text:word, entry, isPhrase:false, doc, idx, spanEl, overlay,
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
    body += '<div class="popup-section-title" id="onlineTitle"'+(App.state.source!=='youdao'?' style="display:none"':'')+'>在线释义 · 有道</div><div id="onlineSec"></div>';
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
      <div class="popup-section-title" id="onlineTitle"${App.state.source!=='youdao'?' style="display:none"':''}>在线释义 · 有道</div>
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
