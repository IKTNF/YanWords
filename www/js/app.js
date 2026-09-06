'use strict';
/* ============ 全局应用状态与公共能力 ============ */
const App = {
  state: { source:'offline', wsZoom:17, memZoom:16, wsLeftW:252, wsRightW:342, wsLeftHidden:false, wsRightHidden:false },
  index: new Map(),
  famIndex: new Map(),

  boot(){
    // 恢复设置
    try{
      const saved = JSON.parse(localStorage.getItem('kyw_settings_v1')||'{}');
      Object.assign(this.state, saved);
    }catch(e){}
    // 词库索引
    for(const r of (window.KAOYAN_DICT||[])) this.index.set(r[0].toLowerCase(), r);
    this.buildFamIndex();
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

  /* ---------- 词族（词群）索引 ---------- */
  buildFamIndex(){
    this.famIndex = new Map();
    for(const r of (window.KAOYAN_DICT||[])){
      const w = r[0].toLowerCase();
      for(const s of wordStemSet(w)){
        if(!this.famIndex.has(s)) this.famIndex.set(s, []);
        this.famIndex.get(s).push(w);
      }
    }
  },

  dictFamily(word, max){
    max = max || 10;
    const w = String(word||'').toLowerCase().replace(/[^a-z]/g,'');
    if(!w) return [];
    const cand = new Map();
    for(const s of wordStemSet(w)){
      for(const k of (this.famIndex.get(s)||[])){
        if(k!==w && !cand.has(k)) cand.set(k, this.makeEntry(k));
        if(cand.size>=max*3) break;
      }
      if(cand.size>=max*3) break;
    }
    // 前缀/包含关系补充
    for(const r of (window.KAOYAN_DICT||[])){
      const k = r[0].toLowerCase();
      if(k===w || cand.has(k)) continue;
      const m = Math.min(k.length, w.length);
      if(m>=5 && (k.startsWith(w) || w.startsWith(k) || k.includes(w) || w.includes(k))){
        cand.set(k, this.makeEntry(k));
        if(cand.size>=max*3) break;
      }
    }
    const list = [...cand.values()];
    list.sort((a,b)=>(a.freq==null?1e9:a.freq)-(b.freq==null?1e9:b.freq));
    return list.slice(0, max);
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
      const r = await fetch('/api/dict?q='+encodeURIComponent(q)+'&source=youdao', {signal: AbortSignal.timeout(12000)});
      const d = await r.json();
      if(!r.ok || d.error) return { senses:[], phonetic:'', error:(d&&d.error)||('HTTP '+r.status) };
      const p = this.parseYoudao(d);
      return { senses:p.senses, phonetic:p.phonetic, error:'' };
    }catch(e){
      const timedOut = e && (e.name==='TimeoutError' || e.name==='AbortError');
      return { senses:[], phonetic:'', error: timedOut ? '在线查询超时，请稍后重试或改用内置离线词库' : String(e&&e.message||e) };
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

/* ---------- 词族（词群）公共算法：generate / generator / regeneration 等 ---------- */
function wordStemSet(w){
  let t = String(w||'').toLowerCase().replace(/[^a-z]/g,'');
  const s = new Set();
  if(t.length>=4) s.add(t);
  const suf = ['ization','isation','ingly','edly','ities','ation','ition','ness','ment','tion','sion','able','ible','ance','ence','ship','hood','ive','ous','ful','less','ize','ise','ify','ate','ity','ist','ism','ian','ing','ied','ies','est','ant','ent','ary','ory','ure','cy','ly','er','or','ion','ed','es','ic','al','ty','y','e','s'];
  for(let k=0;k<3;k++){
    let next = null;
    for(const x of suf){
      if(t.endsWith(x) && t.length-x.length>=4){
        const b = t.slice(0, -x.length);
        if(b.length>=4){ s.add(b); if(!next) next = b; }
      }
    }
    if(!next || next===t) break;
    t = next;
  }
  return s;
}

function lcsLen(a, b){
  const la = a.length, lb = b.length;
  let best = 0;
  for(let i=0;i<la;i++){
    if(la-i <= best) break;
    for(let j=0;j<lb;j++){
      if(lb-j <= best) break;
      let k = 0;
      while(i+k<la && j+k<lb && a[i+k]===b[j+k]) k++;
      if(k > best) best = k;
    }
  }
  return best;
}

function wordsSameFamily(a, b){
  a = String(a||'').toLowerCase().replace(/[^a-z]/g,'');
  b = String(b||'').toLowerCase().replace(/[^a-z]/g,'');
  if(!a || !b || a===b) return false;
  const A = wordStemSet(a), B = wordStemSet(b);
  for(const x of A){ if(B.has(x)) return true; }
  // 最长公共子串 >= 5 视为同族（覆盖 generate/generation、generate/regeneration 等）
  return lcsLen(a, b) >= 5;
}

document.addEventListener('DOMContentLoaded', ()=>App.boot());
