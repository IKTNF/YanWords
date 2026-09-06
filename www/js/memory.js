'use strict';
/* ============ 记忆区：按收录顺序一行一条，可编辑、整体缩放、词群整理、可导出 ============ */
const MEM_EMPTY = '<div class="mem-empty">📭 记忆区还是空的<br><span class="empty-sub">在工作区点击单词/词组，右侧面板中点「收录」，或在词典查询后点「收录到记忆区」</span></div>';

const MEM = {
  items: [],
  _orgSelPos: null,

  init(){
    this.load();
    this.listEl = document.getElementById('memList');
    this.listWrap = document.querySelector('#panel-memory .mem-list-wrap');
    this.panelEl = document.getElementById('panel-memory');
    document.getElementById('btnExportWord').addEventListener('click', ()=>exportWordDoc());
    document.getElementById('btnExportPdf').addEventListener('click', ()=>exportPdfDoc());
    document.getElementById('btnClearMem').addEventListener('click', ()=>this.clearAll());
    document.getElementById('btnOrg').addEventListener('click', ()=>this.openOrg());
    document.getElementById('memZoom').addEventListener('input', e=>{
      App.state.memZoom = +e.target.value;
      document.getElementById('memZoomVal').textContent = e.target.value+'px';
      this.applyZoom(); App.save();
    });
    document.getElementById('memSearch').addEventListener('input', ()=>this.render());
    this.listEl.addEventListener('input', e=>{
      if(e.target.classList.contains('mem-word') || e.target.classList.contains('mem-meaning')) this.onEdit(e);
    });
    this.listEl.addEventListener('click', e=>{
      const b = e.target.closest('.mem-del');
      if(!b) return;
      const row = b.closest('.mem-row');
      if(row) this.remove(row.dataset.id);
    });
    this.applyZoom();
    this.render();
  },

  load(){
    try{ this.items = JSON.parse(localStorage.getItem('kyw_mem_v1')||'[]'); }
    catch(e){ this.items = []; }
  },

  save(){
    localStorage.setItem('kyw_mem_v1', JSON.stringify(this.items));
    App.updateMemBadge();
  },

  add(w, d){
    const item = { id:'m'+Date.now().toString(36)+Math.random().toString(36).slice(2,7),
                   w:String(w||'').trim()||'(空)', d:String(d||'') };
    this.items.push(item);
    this.save();
    this.render();
    const row = this.listEl.querySelector('[data-id="'+item.id+'"]');
    if(row) row.scrollIntoView({block:'nearest', behavior:'smooth'});
    return item;
  },

  remove(id){
    const it = this.items.find(x=>x.id===id);
    this.items = this.items.filter(x=>x.id!==id);
    this.save();
    this.render();
    if(it) App.toast('已删除「'+it.w+'」');
  },

  clearAll(){
    if(!this.items.length){ App.toast('记忆区已经是空的'); return; }
    if(!confirm('确定清空记忆区全部 '+this.items.length+' 条记录？此操作不可恢复。')) return;
    this.items = [];
    this.save();
    this.render();
    App.toast('记忆区已清空');
  },

  onEdit(e){
    const row = e.target.closest('.mem-row');
    if(!row) return;
    const it = this.items.find(x=>x.id===row.dataset.id);
    if(!it) return;
    if(e.target.classList.contains('mem-word')) it.w = e.target.textContent.replace(/\s+/g,' ').trim() || it.w;
    else it.d = e.target.textContent;
    this.save();
  },

  /* 记忆区缩放：只作用于单词/释义列表区域，工具栏（含滑条）保持固定 */
  applyZoom(){ if(this.listWrap) this.listWrap.style.fontSize = (App.state.memZoom||16)+'px'; },

  render(){
    const q = (document.getElementById('memSearch').value||'').trim().toLowerCase();
    const items = this.items.filter(it=>!q || (it.w||'').toLowerCase().includes(q) || (it.d||'').toLowerCase().includes(q));
    if(!items.length){
      this.listEl.innerHTML = this.items.length ? '<div class="empty small">没有匹配的记录</div>' : MEM_EMPTY;
    }else{
      const byId = new Map(this.items.map((it,i)=>[it.id,i]));
      this.listEl.innerHTML = items.map(it=>{
        const idx = (byId.get(it.id)!=null?byId.get(it.id):0)+1;
        return `<div class="mem-row" data-id="${App.esc(it.id)}">
          <div class="mem-idx">${idx}</div>
          <div class="mem-body">
            <div class="mem-word" contenteditable="true" spellcheck="false">${App.esc(it.w)}</div>
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
