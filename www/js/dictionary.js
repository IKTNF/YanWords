'use strict';
/* ============ 词典：英→中 / 中→英，离线词库 + 有道在线 ============ */
const DICT = {
  init(){
    document.getElementById('btnSearch').addEventListener('click', ()=>this.search());
    document.getElementById('dictInput').addEventListener('keydown', e=>{ if(e.key==='Enter') this.search(); });
    this.resultsEl = document.getElementById('dictResults');
    this.resultsEl.addEventListener('click', e=>{
      const famAdd = e.target.closest('[data-fam-add]');
      if(famAdd){
        e.stopPropagation();
        const w = famAdd.dataset.famAdd;
        const en = App.dictLookup(w);
        MEM.add(w, en ? en.defs.join('\n') : '');
        App.toast('已收录「'+w+'」到记忆区');
        return;
      }
      const famRow = e.target.closest('[data-fam]');
      if(famRow){
        document.getElementById('dictInput').value = famRow.dataset.fam;
        this.search(famRow.dataset.fam);
        return;
      }
      const b = e.target.closest('[data-collect]');
      if(!b) return;
      this.collectFrom(b);
    });
  },

  search(q){
    q = (q!==undefined ? String(q) : String(document.getElementById('dictInput').value||'')).trim();
    if(!q){ App.toast('请输入要查询的单词'); return; }
    document.getElementById('dictInput').value = q;
    const zh = /[\u4e00-\u9fff]/.test(q);
    this.resultsEl.innerHTML = '';

    if(!zh){
      const entry = App.dictLookup(q);
      let fam = [];
      if(entry){
        const clean = q.toLowerCase().replace(/[^a-z]/g,'');
        if(clean && clean !== entry.w.toLowerCase()){
          fam = [entry, ...App.dictFamily(entry.w, 9)];   // 派生形式：原形排词群首位
        }else{
          fam = App.dictFamily(entry.w, 10);
        }
      }else{
        fam = App.dictFamily(q, 10);
      }
      if(entry) this.resultsEl.innerHTML += this.entryCard(entry, false, fam);
      if(App.state.source==='youdao') this.onlineCard(q);
      if(!entry && App.state.source==='offline'){
        this.resultsEl.innerHTML += '<div class="dict-card"><div class="note-line">离线词库中未找到「'+App.esc(q)+'」，可切换顶栏词库来源为「有道词典（在线）」查询。</div></div>';
      }
      const related = App.dictPrefix(q, entry ? entry.w.toLowerCase() : null, 10);
      if(related.length){
        this.resultsEl.innerHTML += '<div class="dict-card"><div class="popup-section-title">相近单词</div>'
          + related.map(r=>this.entryCard(r, true)).join('') + '</div>';
      }
    }else{
      if(App.state.source==='youdao') this.onlineCard(q);
      const found = App.dictSearchZh(q);
      if(found.length){
        this.resultsEl.innerHTML += '<div class="dict-card"><div class="popup-section-title">离线词库（考研）匹配 '+found.length+' 条</div>'
          + found.map(r=>this.entryCard(r)).join('') + '</div>';
      }else if(App.state.source==='offline'){
        this.resultsEl.innerHTML = '<div class="dict-card"><div class="note-line">离线词库释义中未找到「'+App.esc(q)+'」，可切换为「有道词典（在线）」查询。</div></div>';
      }
    }

    if(!this.resultsEl.innerHTML.trim()) this.resultsEl.innerHTML = '<div class="empty small">无结果</div>';
    this.resultsEl.scrollIntoView({block:'start'});
  },

  entryCard(entry, mini, fam){
    const chips = [];
    if(entry.freq!=null) chips.push('<span class="chip">考研大纲词</span>');
    if(entry.freq) chips.push('<span class="chip gray">词频 '+entry.freq+'</span>');
    if(entry.cat && entry.freq==null) chips.push('<span class="chip gray">'+App.esc(entry.cat)+'</span>');
    if(entry.fromWord) chips.push('<span class="chip gray">原形 '+App.esc(entry.w)+'</span>');
    const famHtml = (!mini && fam && fam.length)
      ? '<div class="popup-section-title">词群释义（'+fam.length+'，点击查询 / 📥 收录）</div><div class="fam-list">'
        + fam.map(f=>{
            const isBase = entry && f.w.toLowerCase()===entry.w.toLowerCase();
            return '<div class="fam-row" data-fam="'+App.esc(f.w)+'" title="点击查询该词">'
              + (isBase ? '<span class="chip gray">原形</span>' : '')
              + '<span class="fam-word">'+App.esc(f.w)+'</span>'
              + (f.p?'<span class="popup-phon">'+App.esc(f.p)+'</span>':'')
              + '<span class="fam-def">'+App.esc(f.defs[0]||'')+'</span>'
              + '<button class="fam-add" data-fam-add="'+App.esc(f.w)+'" title="收录到记忆区">📥</button>'
              + '</div>';
          }).join('') + '</div>'
      : '';
    return `<div class="dict-card${mini?' mini':''}">
      <div class="dict-card-head"><span class="popup-word">${App.esc(entry.w)}</span>${entry.p?'<span class="popup-phon">'+App.esc(entry.p)+'</span>':''}${chips.join('')}</div>
      <div class="defs">${entry.defs.map(d=>App.esc(d)).join('\n')}</div>
      ${famHtml}
      ${mini?'':'<button class="btn btn-primary collect-btn" data-collect="'+App.esc(entry.w)+'">📥 收录到记忆区</button>'}
    </div>`;
  },

  onlineCard(q){
    const host = document.createElement('div');
    const box = document.createElement('div');
    box.className = 'dict-card';
    box.innerHTML = '<div class="online-tag">在线 · 有道词典</div><span class="spin"></span><span class="muted">查询中…</span>';
    host.appendChild(box);
    this.resultsEl.insertBefore(host, this.resultsEl.firstChild);
    App.fetchOnline(q).then(res=>{
      let html = '<div class="online-tag">在线 · 有道词典</div>';
      if(res.error){
        html += '<div class="note-line">在线查询失败：'+App.esc(res.error)+'（离线词库不受影响）</div>';
      }else if(res.senses.length){
        html += res.phonetic ? '<div class="popup-phon">'+App.esc(res.phonetic)+'</div>' : '';
        html += '<div class="defs">'+res.senses.map(s=>App.esc(s)).join('\n')+'</div>';
        html += '<button class="btn btn-primary collect-btn" data-collect="'+App.esc(q)+'">📥 收录到记忆区</button>';
      }else{
        html += '<div class="note-line">在线词典无结果</div>';
      }
      box.innerHTML = html;
    });
  },

  collectFrom(b){
    const card = b.closest('.dict-card');
    const wEl = card.querySelector('.popup-word');
    const w = (wEl ? wEl.textContent : b.dataset.collect).trim();
    const defsEl = card.querySelector('.defs');
    const d = defsEl ? defsEl.textContent : '';
    MEM.add(w, d||'');
    App.toast('已收录「'+w+'」到记忆区');
  }
};
