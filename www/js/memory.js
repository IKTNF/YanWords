'use strict';
/* ============ 记忆区：多分区（可命名/切换）+ 单词音标 + 朗读 ============ */
const MEM_EMPTY = '<div class="mem-empty">📭 当前分区还是空的<br><span class="empty-sub">在工作区点击单词/词组，右侧面板中点「收录」，或在词典查询后点「收录到记忆区」；收录时可指定分区</span></div>';
const MEM_ZONE_KEY = 'kyw_mem_zones_v1';
const MEM_LEGACY_KEY = 'kyw_mem_v1';

const MEM = {
  zones: [],
  activeZoneId: null,
  _orgSelPos: null,

  /* ---- 当前分区与条目（items 始终指向当前分区，兼容既有调用） ---- */
  zone(id){
    const zid = id || this.activeZoneId;
    return this.zones.find(z=>z.id===zid) || this.zones[0] || null;
  },
  get items(){ const z = this.zone(); return z ? z.items : []; },
  set items(v){ const z = this.zone(); if(z) z.items = v; },
  zoneName(id){ const z = this.zone(id); return z ? z.name : ''; },

  newZoneId(){ return 'z'+Date.now().toString(36)+Math.random().toString(36).slice(2,5); },
  newItemId(){ return 'm'+Date.now().toString(36)+Math.random().toString(36).slice(2,7); },

  init(){
    this.load();
    this.listEl = document.getElementById('memList');
    this.listWrap = document.querySelector('#panel-memory .mem-list-wrap');
    this.panelEl = document.getElementById('panel-memory');
    document.getElementById('btnExportWord').addEventListener('click', ()=>exportWordDoc());
    document.getElementById('btnExportPdf').addEventListener('click', ()=>exportPdfDoc());
    document.getElementById('btnClearMem').addEventListener('click', ()=>this.clearAll());
    document.getElementById('btnOrg').addEventListener('click', ()=>this.openOrg());
    document.getElementById('btnImport').addEventListener('click', ()=>document.getElementById('fileImport').click());
    document.getElementById('fileImport').addEventListener('change', async e=>{
      const files = [...e.target.files];
      e.target.value = '';
      await this.handleImport(files);
    });
    document.getElementById('memZoom').addEventListener('input', e=>{
      App.state.memZoom = +e.target.value;
      document.getElementById('memZoomVal').textContent = e.target.value+'px';
      this.applyZoom(); App.save();
    });
    document.getElementById('memSearch').addEventListener('input', ()=>this.render());
    // 分区操作
    document.getElementById('memZoneSel').addEventListener('change', e=>this.switchZone(e.target.value));
    document.getElementById('btnZoneAdd').addEventListener('click', ()=>this.addZone());
    document.getElementById('btnZoneRename').addEventListener('click', ()=>this.renameZone());
    document.getElementById('btnZoneDel').addEventListener('click', ()=>this.deleteZone());
    this.listEl.addEventListener('input', e=>{
      if(e.target.classList.contains('mem-word') || e.target.classList.contains('mem-meaning')) this.onEdit(e);
    });
    this.listEl.addEventListener('click', e=>{
      const del = e.target.closest('.mem-del');
      if(del){
        const row = del.closest('.mem-row');
        if(row) this.remove(row.dataset.id);
        return;
      }
      const spk = e.target.closest('[data-spk]');
      if(spk){ SPEAK.say(spk.dataset.spk); return; }
      const row = e.target.closest('.mem-row');
      if(row && App.state.autoSpeak){
        const it = this.items.find(x=>x.id===row.dataset.id);
        if(it) SPEAK.say(it.w);
      }
    });
    this.renderZoneBar();
    this.applyZoom();
    this.render();
  },

  /* ---- 载入：分区结构；旧版单区数据自动迁移为「默认分区」 ---- */
  load(){
    let data = null;
    try{ data = JSON.parse(localStorage.getItem(MEM_ZONE_KEY)||'null'); }catch(e){ data = null; }
    if(data && Array.isArray(data.zones) && data.zones.length){
      this.zones = data.zones.map(z=>({
        id: z.id || this.newZoneId(),
        name: String(z.name||'未命名分区'),
        items: (Array.isArray(z.items)?z.items:[]).map(it=>({ id: it.id || this.newItemId(), w: String(it.w||''), d: String(it.d||''), p: String(it.p||'') }))
      }));
      this.activeZoneId = this.zones.some(z=>z.id===data.activeId) ? data.activeId : this.zones[0].id;
      return;
    }
    let legacy = [];
    try{ legacy = JSON.parse(localStorage.getItem(MEM_LEGACY_KEY)||'[]'); }catch(e){ legacy = []; }
    this.zones = [{
      id: this.newZoneId(), name: '默认分区',
      items: (Array.isArray(legacy)?legacy:[]).map(it=>({ id: it.id || this.newItemId(), w: String(it.w||''), d: String(it.d||''), p: String(it.p||'') }))
    }];
    this.activeZoneId = this.zones[0].id;
    this.save();
  },

  save(){
    try{ localStorage.setItem(MEM_ZONE_KEY, JSON.stringify({ zones: this.zones, activeId: this.activeZoneId })); }
    catch(e){ App.toast('记忆区保存失败（本机存储可能已满）','err'); }
    App.updateMemBadge();
  },

  /* ---- 分区管理 ---- */
  renderZoneBar(){
    const sel = document.getElementById('memZoneSel');
    if(sel){
      sel.innerHTML = this.zones.map(z=>'<option value="'+App.esc(z.id)+'">'+App.esc(z.name)+'（'+z.items.length+'）</option>').join('');
      sel.value = this.activeZoneId;
    }
    const info = document.getElementById('memZoneInfo');
    if(info) info.textContent = '共 '+this.zones.length+' 个分区 · 当前「'+this.zoneName()+'」'+this.items.length+' 条';
  },

  switchZone(id){
    if(!this.zones.some(z=>z.id===id)) return;
    this.activeZoneId = id;
    this.save();
    this.renderZoneBar();
    this.render();
    App.toast('已切换到记忆分区「'+this.zoneName()+'」');
  },

  async addZone(){
    const name = await App.prompt('新建记忆分区','给新分区起个名字（例如：真题生词 / 阅读高频 / 写作短语）：','新分区');
    if(name===null) return;
    const n = String(name).trim();
    if(!n){ App.toast('分区名不能为空','err'); return; }
    if(this.zones.some(z=>z.name===n)){ App.toast('已存在同名分区：'+n,'err'); return; }
    const z = { id:this.newZoneId(), name:n, items:[] };
    this.zones.push(z);
    this.activeZoneId = z.id;
    this.save();
    this.renderZoneBar();
    this.render();
    App.toast('已新建并切换到分区「'+n+'」');
  },

  async renameZone(){
    const z = this.zone();
    if(!z) return;
    const name = await App.prompt('重命名分区','新的分区名称（当前：'+z.name+'）：', z.name);
    if(name===null) return;
    const n = String(name).trim();
    if(!n){ App.toast('分区名不能为空','err'); return; }
    if(this.zones.some(x=>x!==z && x.name===n)){ App.toast('已存在同名分区：'+n,'err'); return; }
    const old = z.name;
    z.name = n;
    this.save();
    this.renderZoneBar();
    App.toast('分区「'+old+'」已重命名为「'+n+'」');
  },

  async deleteZone(){
    const z = this.zone();
    if(!z) return;
    if(this.zones.length <= 1){ App.toast('至少需要保留一个分区','err'); return; }
    if(!(await App.confirm('删除分区「'+z.name+'」？其中的 '+z.items.length+' 条记录将一并删除，且不可恢复。'))) return;
    const idx = this.zones.indexOf(z);
    this.zones.splice(idx, 1);
    this.activeZoneId = this.zones[Math.max(0, idx-1)].id;
    if(App.state.collectZone === z.id){ App.state.collectZone = ''; App.save(); }   // 清理指向已删分区的收录设置
    this.save();
    this.renderZoneBar();
    this.render();
    App.toast('已删除分区「'+z.name+'」');
  },

  /* 供工作区/词典下拉选择「收录到哪个分区」 */
  zoneOptionsHtml(selectedId){
    const sel = selectedId || this.activeZoneId;
    return this.zones.map(z=>'<option value="'+App.esc(z.id)+'"'+(z.id===sel?' selected':'')+'>'+App.esc(z.name)+'（'+z.items.length+'）</option>').join('');
  },

  /* ---- 条目操作 ---- */
  add(w, d, zoneId){
    const z = this.zone(zoneId);
    if(!z) return null;
    const word = String(w||'').trim()||'(空)';
    const item = { id:this.newItemId(), w:word, d:String(d||''), p:phonOf(word) };
    z.items.push(item);
    this.save();
    this.renderZoneBar();
    if(z.id===this.activeZoneId){
      this.render();
      const row = this.listEl.querySelector('[data-id="'+item.id+'"]');
      if(row) row.scrollIntoView({block:'nearest', behavior:'smooth'});
    }
    return item;
  },

  remove(id){
    const it = this.items.find(x=>x.id===id);
    this.items = this.items.filter(x=>x.id!==id);
    this.save();
    this.renderZoneBar();
    this.render();
    if(it) App.toast('已删除「'+it.w+'」');
  },

  async clearAll(){
    if(!this.items.length){ App.toast('当前分区已经是空的'); return; }
    if(!(await App.confirm('确定清空分区「'+this.zoneName()+'」全部 '+this.items.length+' 条记录？此操作不可恢复（其他分区不受影响）。'))) return;
    this.items = [];
    this.save();
    this.renderZoneBar();
    this.render();
    App.toast('分区「'+this.zoneName()+'」已清空');
  },

  onEdit(e){
    const row = e.target.closest('.mem-row');
    if(!row) return;
    const it = this.items.find(x=>x.id===row.dataset.id);
    if(!it) return;
    if(e.target.classList.contains('mem-word')){
      it.w = e.target.textContent.replace(/\s+/g,' ').trim() || it.w;
      it.p = phonOf(it.w);
      const spk = row.querySelector('[data-spk]');
      if(spk){ spk.dataset.spk = it.w; spk.title = '朗读 '+it.w; }
    }else{
      it.d = e.target.textContent;
    }
    this.save();
    // 音标与词形变化随编辑实时刷新（只更新该行，不打断输入）
    const pEl = row.querySelector('.mem-phon');
    if(pEl){
      pEl.textContent = it.p ? '音标 /'+it.p.replace(/^\/|\/$/g,'')+'/' : '';
      pEl.style.display = it.p ? '' : 'none';
    }
    const fEl = row.querySelector('.mem-forms');
    const entry = App.dictLookup(it.w);
    const pos = App.posOfText(it.d) || (entry ? App.posOfEntry(entry) : '');
    const base = entry ? entry.w : String(it.w).toLowerCase().replace(/[^a-z]/g,'');
    const forms = App.wordForms(base, pos);
    if(fEl){
      fEl.textContent = forms ? (forms.label+'：'+forms.items.map(([k,v])=>k+' '+v).join(' · ')) : '';
    }
  },

  /* 记忆区缩放：只作用于单词/释义列表区域，工具栏（含滑条）保持固定 */
  applyZoom(){ if(this.listWrap) this.listWrap.style.fontSize = (App.state.memZoom||16)+'px'; },

  /* ================= 导入（Word / PDF，与导出的格式互通） ================= */
  async handleImport(files){
    const entries = [];
    for(const f of files){
      const ext = (f.name.split('.').pop()||'').toLowerCase();
      try{
        let text = '';
        if(ext==='docx'||ext==='doc') text = await this.importDocx(f);
        else if(ext==='pdf') text = await this.importPdf(f);
        else { App.toast('仅支持导入 Word(.docx) / PDF：'+f.name,'err'); continue; }
        if(!text.trim()){ App.toast('未提取到文字内容：'+f.name+'（扫描版 PDF 请先在扫描模式框选识别后收录）','err'); continue; }
        const es = parseImportEntries(text);
        if(!es.length){ App.toast('未从文件中解析出词条：'+f.name,'err'); continue; }
        entries.push(...es);
        App.toast('解析 '+f.name+'：'+es.length+' 条');
      }catch(err){
        console.error(err);
        App.toast('导入失败 '+f.name+'：'+(err&&err.message||err),'err');
      }
    }
    if(!entries.length) return;
    if(!(await App.confirm('将从 '+files.length+' 个文件导入 '+entries.length+' 条记录，追加到当前分区「'+this.zoneName()+'」末尾。继续？'))) return;
    for(const e of entries){
      this.items.push({ id:this.newItemId(), w:e.w, d:e.d, p:e.p || phonOf(e.w) });
    }
    this.save();
    this.renderZoneBar();
    this.render();
    App.toast('已导入 '+entries.length+' 条到分区「'+this.zoneName()+'」');
  },

  async importDocx(file){
    await ensureMammoth();
    if(!window.mammoth) throw new Error('Word 解析组件未加载');
    const arrayBuffer = await file.arrayBuffer();
    const res = await mammoth.extractRawText({arrayBuffer});
    return res.value;
  },

  async importPdf(file){
    await ensurePdfjs();
    if(!window.pdfjsLib) throw new Error('PDF 解析组件未加载');
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
    const pages = [];
    const max = Math.min(pdf.numPages, 1000);
    for(let i=1;i<=max;i++){
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
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
      if(i%50===0) App.toast('解析 PDF 中… '+i+'/'+max+' 页');
    }
    return pages.join('\n\n');
  },

  render(){
    const q = (document.getElementById('memSearch').value||'').trim().toLowerCase();
    const items = this.items.filter(it=>!q || (it.w||'').toLowerCase().includes(q) || (it.d||'').toLowerCase().includes(q));
    if(!items.length){
      this.listEl.innerHTML = this.items.length ? '<div class="empty small">没有匹配的记录</div>' : MEM_EMPTY;
    }else{
      const byId = new Map(this.items.map((it,i)=>[it.id,i]));
      this.listEl.innerHTML = items.map(it=>{
        const idx = (byId.get(it.id)!=null?byId.get(it.id):0)+1;
        const entry = App.dictLookup(it.w);
        const pos = App.posOfText(it.d) || (entry ? App.posOfEntry(entry) : '');
        const base = entry ? entry.w : String(it.w).toLowerCase().replace(/[^a-z]/g,'');
        const forms = App.wordForms(base, pos);
        const phon = it.p || (entry && entry.p) || '';
        const formsHtml = forms
          ? '<div class="mem-forms">'+App.esc(forms.label)+'：'+forms.items.map(([k,v])=>k+' '+App.esc(v)).join(' · ')+'</div>'
          : '';
        const phonHtml = phon
          ? '<div class="mem-phon">音标 /'+App.esc(phon.replace(/^\/|\/$/g,''))+'/</div>'
          : '';
        return `<div class="mem-row" data-id="${App.esc(it.id)}">
          <div class="mem-idx">${idx}</div>
          <div class="mem-body">
            <div class="mem-wcol">
              <div class="mem-word-line">
                <div class="mem-word" contenteditable="true" spellcheck="false">${App.esc(it.w)}</div>
                ${spkBtn(it.w)}
              </div>
              ${phonHtml}
              ${formsHtml}
            </div>
            <div class="mem-meaning" contenteditable="true" spellcheck="false">${App.esc(it.d)}</div>
          </div>
          <button class="mem-del" title="删除">✕</button>
        </div>`;
      }).join('');
    }
    App.updateMemBadge();
  },

  /* ================= 词群整理 ================= */
  openOrg(){
    if(!this.items.length){ App.toast('记忆区为空，无可整理的内容'); return; }
    const old = document.getElementById('orgModal');
    if(old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'orgModal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head">🔀 词群整理 <button class="popup-close" data-org="close" title="关闭">✕</button></div>
      <div class="modal-body">
        <div class="org-tabs">
          <button class="org-tab active" data-omode="single">指定单词整理</button>
          <button class="org-tab" data-omode="batch">一键整理</button>
        </div>
        <div class="org-pane" id="orgPaneSingle">
          <div class="note-line">输入一个单词，把记忆区中它的词群（词性变化/派生/相关词，如 generate 与 generator）整理到一起。</div>
          <input type="text" id="orgWord" placeholder="输入单词，如 generate / economy">
          <div id="orgFamily" class="org-family"></div>
          <label class="org-pos-row"><input type="radio" name="orgPos" value="member" checked> 整理到所选词群成员的位置</label>
          <label class="org-pos-row"><input type="radio" name="orgPos" value="index"> 整理到指定序号
            <input type="number" id="orgIndex" min="1" max="${this.items.length}" value="1"></label>
          <button class="btn btn-primary btn-block" data-org="run">开始整理</button>
        </div>
        <div class="org-pane hidden" id="orgPaneBatch">
          <div class="note-line">把选定范围内所有词群自动分组并相邻排列（词群内按单词长度排序，词干最短的排最前）。</div>
          <div class="org-range-row">
            <label class="org-pos-row"><input type="radio" name="orgRange" value="all" checked> 全部范围（共 ${this.items.length} 条）</label>
            <label class="org-pos-row"><input type="radio" name="orgRange" value="part"> 序号范围
              <input type="number" id="orgR1" min="1" max="${this.items.length}" value="1"> —
              <input type="number" id="orgR2" min="1" max="${this.items.length}" value="${this.items.length}"></label>
          </div>
          <div id="orgPreview" class="org-preview"></div>
          <button class="btn btn-primary btn-block" data-org="runBatch">一键整理</button>
        </div>
      </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('mousedown', e=>{ if(e.target===modal) this.closeOrg(); });
    modal.querySelectorAll('[data-org="close"]').forEach(b=>b.addEventListener('click', ()=>this.closeOrg()));
    modal.querySelectorAll('.org-tab').forEach(t=>t.addEventListener('click', ()=>{
      modal.querySelectorAll('.org-tab').forEach(x=>x.classList.toggle('active', x===t));
      document.getElementById('orgPaneSingle').classList.toggle('hidden', t.dataset.omode!=='single');
      document.getElementById('orgPaneBatch').classList.toggle('hidden', t.dataset.omode!=='batch');
      if(t.dataset.omode==='batch') this.previewBatch();
    }));
    const wordInput = document.getElementById('orgWord');
    wordInput.addEventListener('input', ()=>this.renderFamily(wordInput.value));
    const famEl = document.getElementById('orgFamily');
    famEl.addEventListener('click', e=>{
      const chip = e.target.closest('.org-chip');
      if(!chip) return;
      famEl.querySelectorAll('.org-chip').forEach(c=>c.classList.toggle('sel', c===chip));
      this._orgSelPos = +chip.dataset.pos;
      const r = modal.querySelector('input[name="orgPos"][value="member"]');
      if(r) r.checked = true;
    });
    modal.querySelector('[data-org="run"]').addEventListener('click', ()=>this.runSingle(wordInput.value));
    modal.querySelector('[data-org="runBatch"]').addEventListener('click', ()=>this.runBatch());
    wordInput.focus();
  },

  closeOrg(){ const m = document.getElementById('orgModal'); if(m) m.remove(); this._orgSelPos = null; },

  renderFamily(word){
    const el = document.getElementById('orgFamily');
    if(!el) return;
    const w = String(word||'').trim().toLowerCase();
    if(!w){ el.innerHTML = ''; this._orgSelPos = null; return; }
    let related = this.items.filter(it=>wordsSameFamily(String(it.w), w));
    const exactIdx = this.items.findIndex(it=>String(it.w).toLowerCase()===w);
    if(exactIdx>=0 && !related.includes(this.items[exactIdx])) related.push(this.items[exactIdx]);
    if(!related.length){
      el.innerHTML = '<div class="note-line">记忆区中未找到「'+App.esc(word)+'」的词群成员（试试输入记忆区中已有的单词）。</div>';
      this._orgSelPos = null;
      return;
    }
    // 按记忆区序号排序展示
    related.sort((a,b)=>(this.items.indexOf(a) - this.items.indexOf(b)));
    el.innerHTML = related.map(it=>{
      const pos = this.items.indexOf(it)+1;
      return '<span class="org-chip" data-pos="'+pos+'">'+App.esc(it.w)+'（'+pos+'）</span>';
    }).join('');
    // 默认选中：输入的单词本身（若在记忆区中），否则第一个成员
    this._orgSelPos = exactIdx>=0 ? exactIdx+1 : this.items.indexOf(related[0])+1;
    el.querySelectorAll('.org-chip').forEach(c=>c.classList.toggle('sel', +c.dataset.pos===this._orgSelPos));
  },

  runSingle(word){
    const w = String(word||'').trim().toLowerCase();
    if(!w){ App.toast('请输入单词','err'); return; }
    const group = this.items.filter(it=>wordsSameFamily(String(it.w), w));
    const exact = this.items.find(it=>String(it.w).toLowerCase()===w);
    if(exact && !group.includes(exact)) group.push(exact);
    if(!group.length){ App.toast('记忆区中未找到「'+word+'」的词群','err'); return; }
    group.sort((a,b)=>String(a.w).length-String(b.w).length || String(a.w).localeCompare(String(b.w)));
    const mode = (document.querySelector('input[name="orgPos"]:checked')||{}).value;
    // 确定锚点：词群插入到锚点之后，锚点本身保持原位
    let anchor = null, anchorName = '';
    if(mode==='index'){
      const n = parseInt(document.getElementById('orgIndex').value||'1',10)||1;
      if(n >= 1 && n <= this.items.length) anchor = this.items[n-1];
      anchorName = anchor ? anchor.w : '';
    }else{
      anchor = this.items.find(it=>this.items.indexOf(it)+1===this._orgSelPos) || null;
      if(!anchor){ App.toast('请先在上方选择一个词群成员作为整理位置','err'); return; }
      anchorName = anchor.w;
    }
    // 锚点若属于词群则不动，其余成员插到其后；否则整组插到锚点之后
    const others = (anchor && group.includes(anchor)) ? group.filter(it=>it!==anchor) : group;
    const rest = this.items.filter(it=>!others.includes(it));
    if(anchor && rest.includes(anchor)){
      const ti = rest.indexOf(anchor);
      rest.splice(ti+1, 0, ...others);
    }else{
      rest.unshift(...others);
    }
    this.items = rest;
    this.save();
    this.render();
    this.closeOrg();
    App.toast('已将「'+w+'」词群 '+others.length+' 个词整理到'+(anchor ? '「'+anchorName+'」之后' : '最前面'));
  },

  previewBatch(){
    const el = document.getElementById('orgPreview');
    if(!el) return;
    const range = this.batchRange();
    const groups = groupByFamily(range.items);
    const big = groups.filter(g=>g.length>=2);
    if(!big.length){ el.innerHTML = '范围内没有发现 2 个及以上的词群。'; return; }
    el.innerHTML = '发现 <b>'+big.length+'</b> 个词群：<br>'
      + big.map(g=>'<span class="org-chip gray" style="cursor:default">'+App.esc(g[0].w)+' 群（'+g.length+' 词）</span>').join(' ');
  },

  batchRange(){
    const mode = (document.querySelector('input[name="orgRange"]:checked')||{}).value;
    if(mode==='part'){
      const a = parseInt(document.getElementById('orgR1').value||'1',10)||1;
      const b = parseInt(document.getElementById('orgR2').value||'1',10)||1;
      const s = Math.max(0, Math.min(a,b)-1);
      const e = Math.min(this.items.length, Math.max(a,b));
      return {start:s, end:e, items:this.items.slice(s, e)};
    }
    return {start:0, end:this.items.length, items:this.items.slice()};
  },

  runBatch(){
    const {start, end, items} = this.batchRange();
    if(!items.length){ App.toast('范围为空','err'); return; }
    const groups = groupByFamily(items);
    const newSlice = groups.flat();
    this.items = [...this.items.slice(0,start), ...newSlice, ...this.items.slice(end)];
    this.save();
    this.render();
    this.closeOrg();
    const n = groups.filter(g=>g.length>=2).length;
    App.toast('一键整理完成：'+n+' 个词群已相邻排列');
  }
};

/* 把条目按词族分组：组按首次出现顺序，组内按单词长度排序 */
function groupByFamily(items){
  const groups = [];
  const used = new Set();
  items.forEach((it, i)=>{
    if(used.has(i)) return;
    const g = [{it, idx:i}];
    used.add(i);
    for(let j=i+1;j<items.length;j++){
      if(!used.has(j) && wordsSameFamily(String(items[j].w), String(it.w))){
        g.push({it:items[j], idx:j});
        used.add(j);
      }
    }
    g.sort((a,b)=>String(a.it.w).length-String(b.it.w).length || String(a.it.w).localeCompare(String(b.it.w)));
    groups.push({first:i, members:g.map(x=>x.it)});
  });
  groups.sort((a,b)=>a.first-b.first);
  return groups.map(g=>g.members);
}

/* 解析导入文本：支持 "1. word [音标]　释义"（同一行，音标可选）或 "1. word" + 后续释义行 */
function parseImportEntries(text){
  const entries = [];
  const lines = String(text).split(/\r?\n/);
  let cur = null;
  const flush = ()=>{
    if(cur && cur.w){
      entries.push({ w:cur.w, d:(cur.d||'').replace(/\s+$/,''), p:cur.p||'' });
    }
    cur = null;
  };
  const skipRe = /^(考研英语一词汇笔记|共\s*\d+\s*条|导出时间|……|（在打印对话框)/;
  for(const raw of lines){
    const line = raw.replace(/\u00a0/g,' ').trim();
    if(!line){ flush(); continue; }
    if(skipRe.test(line)) continue;
    const m = line.match(/^(\d{1,4})[.、．)）\s]+(.+)$/);
    if(m && /^[A-Za-z]/.test(m[2])){
      flush();
      const content = m[2].trim();
      // 优先匹配「单词 [音标] 释义」形式（导出文件自带音标）
      const pm = content.match(/^([^\s　]+)[\s　]+\[([^\]]{1,60})\][\s　]*(.*)$/);
      if(pm){ cur = { w: pm[1], p: pm[2].trim(), d: pm[3] || '' }; continue; }
      const wm = content.match(/^([^\s　]+)[\s　]*(.*)$/);
      cur = { w: wm ? wm[1] : content, p: '', d: wm ? wm[2] : '' };
    }else if(cur){
      cur.d = cur.d ? cur.d+'\n'+line : line;
    }else{
      const wm = line.match(/^([A-Za-z][A-Za-z'’\- ]{1,40}?)[\s　]+(.+)$/);
      if(wm && wm[2].length>=2) cur = { w: wm[1], p:'', d: wm[2] };
    }
  }
  flush();
  return entries;
}
