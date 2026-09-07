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
    if(!q){ App.toast('请输入要查询或翻译的内容'); return; }
    document.getElementById('dictInput').value = q;
    const zh = /[\u4e00-\u9fff]/.test(q);
    const singleEn = !zh && /^[A-Za-z][A-Za-z'’\-]*$/.test(q);
    this.resultsEl.innerHTML = '';

    // 静态结果一次性拼接写入；翻译卡片最后插入，避免 innerHTML 重建销毁异步节点
    let staticHtml = '';
    if(singleEn){
      // 单个英文单词：查词（释义/词形/词群）+ 翻译
      const entry = App.dictLookup(q);
      const disp = String(q).trim();
      let fam = [];
      if(entry){
        const clean = disp.toLowerCase().replace(/[^a-z]/g,'');
        if(clean && clean !== entry.w.toLowerCase()){
          fam = [entry, ...App.dictFamily(entry.w, 9)];
        }else{
          fam = App.dictFamily(entry.w, 10);
        }
      }else{
        fam = App.dictFamily(disp, 10);
      }
      const forms = entry ? App.wordForms(entry.w, App.posOfEntry(entry)) : null;
      if(entry) staticHtml += this.entryCard(entry, false, fam, disp, forms);
      else staticHtml += '<div class="dict-card"><div class="note-line">离线词库未收录「'+App.esc(disp)+'」，下方给出在线/对照翻译。</div></div>';
      const related = App.dictPrefix(disp, entry ? entry.w.toLowerCase() : null, 10);
      if(related.length){
        staticHtml += '<div class="dict-card"><div class="popup-section-title">相近单词</div>'
          + related.map(r=>this.entryCard(r, true)).join('') + '</div>';
      }
      this.resultsEl.innerHTML = staticHtml;
      this.translateCard(disp, 'zh-CN');
    }else if(!zh){
      // 长段英文：整段翻译
      this.resultsEl.innerHTML = '';
      this.translateCard(q, 'zh-CN');
    }else if(q.length <= 6){
      // 短中文：离线反查 + 中→英翻译
      const found = App.dictSearchZh(q);
      if(found.length){
        staticHtml += '<div class="dict-card"><div class="popup-section-title">离线词库（考研）匹配 '+found.length+' 条</div>'
          + found.map(r=>this.entryCard(r)).join('') + '</div>';
      }else{
        staticHtml += '<div class="dict-card"><div class="note-line">离线词库未找到「'+App.esc(q)+'」对应的单词。</div></div>';
      }
      this.resultsEl.innerHTML = staticHtml;
      this.translateCard(q, 'en');
    }else{
      // 长段中文：整段翻译
      this.resultsEl.innerHTML = '';
      this.translateCard(q, 'en');
    }

    if(!this.resultsEl.innerHTML.trim()) this.resultsEl.innerHTML = '<div class="empty small">无结果</div>';
    this.resultsEl.scrollIntoView({block:'start'});
  },

  entryCard(entry, mini, fam, disp, forms){
    const chips = [];
    if(entry.freq!=null) chips.push('<span class="chip">考研大纲词</span>');
    if(entry.freq) chips.push('<span class="chip gray">词频 '+entry.freq+'</span>');
    if(entry.cat && entry.freq==null) chips.push('<span class="chip gray">'+App.esc(entry.cat)+'</span>');
    if(entry.fromWord) chips.push('<span class="chip gray">原形 '+App.esc(entry.w)+'</span>');
    const title = disp || entry.w;
    const formsHtml = (!mini && forms)
      ? '<div class="forms-line">'+App.esc(forms.label)+'：'+forms.items.map(([k,v])=>k+' '+App.esc(v)).join(' · ')+'</div>'
      : '';
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
      <div class="dict-card-head"><span class="popup-word">${App.esc(title)}</span>${entry && title.toLowerCase()!==entry.w.toLowerCase()?'<span class="chip gray">原形 '+App.esc(entry.w)+'</span>':''}${entry.p?'<span class="popup-phon">'+App.esc(entry.p)+'</span>':''}${chips.join('')}</div>
      <div class="defs">${entry.defs.map(d=>App.esc(d)).join('\n')}</div>
      ${formsHtml}
      ${famHtml}
      ${mini?'':'<button class="btn btn-primary collect-btn" data-collect="'+App.esc(title)+'">📥 收录到记忆区</button>'}
    </div>`;
  },

  translateCard(q, to){
    const host = document.createElement('div');
    const box = document.createElement('div');
    box.className = 'dict-card';
    box.innerHTML = '<div class="online-tag">翻译 · '+(to==='en'?'中→英':'英→中')+'</div><span class="spin"></span><span class="muted">翻译中…</span>';
    host.appendChild(box);
    this.resultsEl.insertBefore(host, this.resultsEl.firstChild);
    App.translate(q, to).then(res=>{
      let html = '<div class="online-tag">'+(res.mode==='online' ? '在线翻译' : '对照翻译（离线）')+'</div>';
      if(res.text){
        html += '<div class="defs">'+App.esc(res.text)+'</div>';
        html += '<button class="btn btn-primary collect-btn" data-collect="'+App.esc(q.slice(0,80))+'">📥 收录原文+译文</button>';
      }else{
        html += '<div class="note-line">翻译失败：'+App.esc(res.error||'未知错误')+'</div>';
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
