'use strict';
/* ============ 全局应用状态与公共能力 ============ */
const App = {
  state: { source:'offline', wsZoom:17, memZoom:16 },
  index: new Map(),

  boot(){
    // 恢复设置
    try{
      const saved = JSON.parse(localStorage.getItem('kyw_settings_v1')||'{}');
      Object.assign(this.state, saved);
    }catch(e){}
    // 词库索引
    for(const r of (window.KAOYAN_DICT||[])) this.index.set(r[0].toLowerCase(), r);
    // 顶栏标签
    document.querySelectorAll('.tab').forEach(t=>{
      t.addEventListener('click', ()=>this.switchTab(t.dataset.tab));
    });
    // 词库来源
    const sel = document.getElementById('srcSelect');
    sel.value = this.state.source;
    sel.addEventListener('change', ()=>{
      this.state.source = sel.value;
      this.save();
      this.toast('词库来源已切换：'+sel.options[sel.selectedIndex].text);
    });
    // 缩放初值
    document.getElementById('wsZoom').value = this.state.wsZoom;
    document.getElementById('wsZoomVal').textContent = this.state.wsZoom+'px';
    document.getElementById('memZoom').value = this.state.memZoom;
    document.getElementById('memZoomVal').textContent = this.state.memZoom+'px';
    // 子面板
    WS.init(); MEM.init(); DICT.init();
    this.updateMemBadge();
    this.toast('欢迎使用研词助手 · 上传资料即可开始识别单词');
  },

  save(){ try{ localStorage.setItem('kyw_settings_v1', JSON.stringify(this.state)); }catch(e){} },

  switchTab(name){
    document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+name));
    if(name==='memory') MEM.render();
  },

  updateMemBadge(){
    const n = (MEM.items||[]).length;
    const b = document.getElementById('memCount');   if(b) b.textContent = n;
    const b2 = document.getElementById('memCount2'); if(b2) b2.textContent = '共 '+n+' 条';
  },

  toast(msg, type){
    const host = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast'+(type==='err'?' err':'');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),320); }, 2600);
  },

  esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); },
  $: (id)=>document.getElementById(id),

  /* ---------- 离线词典查询 ---------- */
  makeEntry(key, fromWord){
    const r = this.index.get(key);
    if(!r) return null;
    return { w:r[0], p:r[1]||'', freq:r[2], cat:r[3]||'',
             defs:(r[4]||'').split('\n').filter(Boolean), fromWord:fromWord||null };
  },

  dictLookup(q){
    const raw = String(q||'').trim();
    if(!raw) return null;
    let low = raw.toLowerCase().replace(/[“”"'‘’()\[\]{}<>«»]/g,'');
    low = low.replace(/^[^a-z\-]+|[^a-z\-]+$/g,'');
    if(!low) return null;
    const tries = [low];
    if(low.includes('-')){ tries.push(low.replace(/-/g,''), low.replace(/-/g,' ')); }
    if(low.includes("'")||low.includes('’')) tries.push(low.replace(/['’]/g,''));
    for(const c of tries){ if(this.index.has(c)) return this.makeEntry(c, c!==low?low:null); }
    const al = (window.KAOYAN_ALIAS||{})[low];
    if(al && this.index.has(al)) return this.makeEntry(al, low);
    const ir = (window.KAOYAN_IRREG||{})[low];
    if(ir && this.index.has(ir)) return this.makeEntry(ir, low);
    const found = [];
    for(const c of morphCandidates(low)){ if(this.index.has(c)) found.push(this.makeEntry(c, low)); }
    if(found.length){
      found.sort((a,b)=>(a.freq==null?1e9:a.freq)-(b.freq==null?1e9:b.freq));
      return found[0];
    }
    return null;
  },

  dictSearchZh(q){
    const low = String(q||'').toLowerCase();
    const out = [];
    for(const r of (window.KAOYAN_DICT||[])){
      if((r[4]||'').toLowerCase().includes(low)){ out.push(this.makeEntry(r[0].toLowerCase())); if(out.length>=60) break; }
    }
    return out;
  },

  dictPrefix(q, exclude, n){
    const low = String(q||'').toLowerCase();
    const out = [];
    for(const r of (window.KAOYAN_DICT||[])){
      const w = r[0].toLowerCase();
      if(w.startsWith(low) && w!==exclude){ out.push(this.makeEntry(w)); if(out.length>=n) break; }
    }
    return out;
  },

  /* ---------- 在线词典 ---------- */
  parseYoudao(d){
    const out = { phonetic:'', senses:[] };
    if(!d || typeof d!=='object') return out;
    const w0 = d.ec && d.ec.word && d.ec.word[0];
    if(w0){
      const ph = w0.usphone||w0.ukphone;
      if(ph) out.phonetic = '['+ph+']';
      for(const t of (w0.trs||[])){
        for(const x of (t.tr||[])){
          const i = x.l && x.l.i;
          if(Array.isArray(i)) for(const s of i){ if(s && !out.senses.includes(s)) out.senses.push(s); }
        }
      }
    }
    if(!out.senses.length){
      const wt = d.web_trans && d.web_trans['web-translation'];
      if(Array.isArray(wt)) for(const t of wt){ if(t.value && !out.senses.includes(t.value)) out.senses.push(t.value); }
    }
    if(!out.senses.length){
      const sm = d.simple && d.simple.word;
      if(Array.isArray(sm)) for(const w of sm){
        const pre = w.usphone ? '['+w.usphone+'] ' : '';
        for(const s of (w.means||[])){ const v = pre+s; if(v && !out.senses.includes(v)) out.senses.push(v); }
      }
    }
    return out;
  },

  async fetchOnline(q){
    try{
      const r = await fetch('/api/dict?q='+encodeURIComponent(q)+'&source=youdao');
      const d = await r.json();
      if(!r.ok || d.error) return { senses:[], phonetic:'', error:(d&&d.error)||('HTTP '+r.status) };
      const p = this.parseYoudao(d);
      return { senses:p.senses, phonetic:p.phonetic, error:'' };
    }catch(e){
      return { senses:[], phonetic:'', error:String(e&&e.message||e) };
    }
  }
};

function morphCandidates(w){
  const out = [];
  const push = (c)=>{ if(c.length>=2 && !out.includes(c)) out.push(c); };
  const rules = [['ies','y'],['es',''],['s',''],['ed',''],['ed','e'],['ing',''],['ing','e'],['er',''],['er','e'],['est',''],['est','e'],['ly',''],['d',''],['d','e']];
  for(const [suf,rep] of rules){
    if(w.endsWith(suf) && w.length > suf.length+1){
      const base = w.slice(0, -suf.length);
      push(base+rep);
      push(base+rep+'e');
      if(base.length>=2 && base[base.length-1]===base[base.length-2]) push(base.slice(0,-1)+rep);
    }
  }
  return out;
}

document.addEventListener('DOMContentLoaded', ()=>App.boot());
