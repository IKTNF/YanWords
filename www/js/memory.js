'use strict';
/* ============ 记忆区：按收录顺序一行一条，可编辑、可缩放、可导出 ============ */
const MEM_EMPTY = '<div class="mem-empty">📭 记忆区还是空的<br><span class="empty-sub">在工作区点击单词/词组，右侧面板中点「收录」，或在词典查询后点「收录到记忆区」</span></div>';

const MEM = {
  items: [],

  init(){
    this.load();
    this.listEl = document.getElementById('memList');
    document.getElementById('btnExportWord').addEventListener('click', ()=>exportWordDoc());
    document.getElementById('btnExportPdf').addEventListener('click', ()=>exportPdfDoc());
    document.getElementById('btnClearMem').addEventListener('click', ()=>this.clearAll());
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

  applyZoom(){ this.listEl.style.fontSize = (App.state.memZoom||16)+'px'; },

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
  }
};
