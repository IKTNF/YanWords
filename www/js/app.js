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
      const r = await fetch('/api/dict?q='+encodeURIComponent(q)+'&source=youdao', {signal: AbortSignal.timeout(15000)});
      const d = await r.json();
      if(!r.ok || d.error) return { senses:[], phonetic:'', source:'', error:(d&&d.error)||('HTTP '+r.status) };
      return { senses:d.senses||[], phonetic:d.phonetic||'', source:d.source||'', error:'' };
    }catch(e){
      const timedOut = e && (e.name==='TimeoutError' || e.name==='AbortError');
      return { senses:[], phonetic:'', source:'', error: timedOut ? '在线词典连接超时，请稍后重试或改用内置离线词库' : String(e&&e.message||e) };
    }
  },

  /* ---------- 弹窗封装：浏览器用原生 confirm/prompt，桌面版(Electron)用应用内模态框 ---------- */
  confirm(msg, title){
    if(!(window.__mupdf && window.__mupdf.desktop)) return Promise.resolve(window.confirm(msg));
    return new Promise(res=>{
      const m = document.createElement('div');
      m.className = 'modal-backdrop';
      m.innerHTML = '<div class="modal-card" style="width:min(440px,92vw)"><div class="modal-head">'+(title||'确认')+'</div>'
        + '<div class="modal-body"><div style="white-space:pre-wrap;line-height:1.7">'+this.esc(msg)+'</div>'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">'
        + '<button class="btn" data-a="0">取消</button><button class="btn btn-primary" data-a="1">确定</button></div></div></div>';
      document.body.appendChild(m);
      const done = (v)=>{ m.remove(); res(v); };
      m.addEventListener('mousedown', e=>{ if(e.target===m) done(false); });
      m.querySelectorAll('[data-a]').forEach(b=>b.addEventListener('click', ()=>done(b.dataset.a==='1')));
      m.querySelector('[data-a="1"]').focus();
    });
  },

  prompt(title, msg, def){
    if(!(window.__mupdf && window.__mupdf.desktop)) return Promise.resolve(window.prompt(msg, def||''));
    return new Promise(res=>{
      const m = document.createElement('div');
      m.className = 'modal-backdrop';
      m.innerHTML = '<div class="modal-card" style="width:min(440px,92vw)"><div class="modal-head">'+(title||'输入')+'</div>'
        + '<div class="modal-body"><div style="white-space:pre-wrap;line-height:1.7;margin-bottom:10px">'+this.esc(msg)+'</div>'
        + '<input type="text" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;outline:none" value="'+this.esc(def||'')+'">'
        + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">'
        + '<button class="btn" data-a="0">取消</button><button class="btn btn-primary" data-a="1">确定</button></div></div></div>';
      document.body.appendChild(m);
      const input = m.querySelector('input');
      const done = (v)=>{ m.remove(); res(v); };
      m.addEventListener('mousedown', e=>{ if(e.target===m) done(null); });
      m.querySelectorAll('[data-a]').forEach(b=>b.addEventListener('click', ()=>done(b.dataset.a==='1' ? (input.value||'') : null)));
      input.addEventListener('keydown', e=>{
        if(e.key==='Enter') done(input.value||'');
        if(e.key==='Escape') done(null);
      });
      input.focus();
    });
  },

  /* ---------- 词性判断与词形变化 ---------- */
  posOfText(text){
    const t = String(text||'').toLowerCase();
    if(/\b(vt?|vi|v|verb)\s*[.．·]/.test(t)) return 'verb';
    if(/\b(adj|a)\s*[.．·]/.test(t)) return 'adj';
    return '';
  },
  posOfEntry(entry){
    return entry ? this.posOfText(entry.defs.join('\n')) : '';
  },
  wordForms(base, pos){
    base = String(base||'').toLowerCase().replace(/[^a-z]/g,'');
    if(!base || base.length<2) return null;
    if(pos==='verb'){
      const v = VERB_IRREG[base];
      if(v) return {label:'动词时态', items:[['三单',v[0]],['过去式',v[1]],['过去分词',v[2]],['现在分词',v[3]]]};
      const f = regVerbForms(base);
      return {label:'动词时态', items:[['三单',f.s],['过去式',f.past],['过去分词',f.pp],['现在分词',f.ing]]};
    }
    if(pos==='adj'){
      const v = ADJ_IRREG[base];
      if(v) return {label:'形容词变化', items:[['比较级',v[0]],['最高级',v[1]]]};
      const f = adjForms(base);
      return {label:'形容词变化', items:[['比较级',f.c],['最高级',f.s]]};
    }
    return null;
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

/* ---------- 不规则动词表: base → [三单, 过去式, 过去分词, 现在分词] ---------- */
const VERB_IRREG = {
  be:['is','was/were','been','being'], have:['has','had','had','having'], do:['does','did','done','doing'],
  go:['goes','went','gone','going'], make:['makes','made','made','making'], take:['takes','took','taken','taking'],
  get:['gets','got','got/gotten','getting'], give:['gives','gave','given','giving'], come:['comes','came','come','coming'],
  see:['sees','saw','seen','seeing'], know:['knows','knew','known','knowing'], think:['thinks','thought','thought','thinking'],
  say:['says','said','said','saying'], tell:['tells','told','told','telling'], become:['becomes','became','become','becoming'],
  find:['finds','found','found','finding'], feel:['feels','felt','felt','feeling'], leave:['leaves','left','left','leaving'],
  bring:['brings','brought','brought','bringing'], buy:['buys','bought','bought','buying'], catch:['catches','caught','caught','catching'],
  teach:['teaches','taught','taught','teaching'], fight:['fights','fought','fought','fighting'], seek:['seeks','sought','sought','seeking'],
  keep:['keeps','kept','kept','keeping'], sleep:['sleeps','slept','slept','sleeping'], speak:['speaks','spoke','spoken','speaking'],
  write:['writes','wrote','written','writing'], run:['runs','ran','run','running'], sit:['sits','sat','sat','sitting'],
  stand:['stands','stood','stood','standing'], understand:['understands','understood','understood','understanding'],
  win:['wins','won','won','winning'], lose:['loses','lost','lost','losing'], pay:['pays','paid','paid','paying'],
  mean:['means','meant','meant','meaning'], meet:['meets','met','met','meeting'], send:['sends','sent','sent','sending'],
  spend:['spends','spent','spent','spending'], build:['builds','built','built','building'], lead:['leads','led','led','leading'],
  hold:['holds','held','held','holding'], grow:['grows','grew','grown','growing'], draw:['draws','drew','drawn','drawing'],
  fly:['flies','flew','flown','flying'], drive:['drives','drove','driven','driving'], ride:['rides','rode','ridden','riding'],
  wear:['wears','wore','worn','wearing'], choose:['chooses','chose','chosen','choosing'], begin:['begins','began','begun','beginning'],
  drink:['drinks','drank','drunk','drinking'], eat:['eats','ate','eaten','eating'], fall:['falls','fell','fallen','falling'],
  break:['breaks','broke','broken','breaking'], forget:['forgets','forgot','forgotten','forgetting'],
  throw:['throws','threw','thrown','throwing'], strike:['strikes','struck','struck','striking'],
  bear:['bears','bore','borne/born','bearing'], swear:['swears','swore','sworn','swearing'], tear:['tears','tore','torn','tearing'],
  rise:['rises','rose','risen','rising'], shake:['shakes','shook','shaken','shaking'], show:['shows','showed','shown/showed','showing'],
  sing:['sings','sang','sung','singing'], ring:['rings','rang','rung','ringing'], swim:['swims','swam','swum','swimming'],
  steal:['steals','stole','stolen','stealing'], weave:['weaves','wove','woven','weaving'], deal:['deals','dealt','dealt','dealing'],
  sell:['sells','sold','sold','selling'], hear:['hears','heard','heard','hearing'], read:['reads','read','read','reading'],
  cut:['cuts','cut','cut','cutting'], put:['puts','put','put','putting'], set:['sets','set','set','setting'],
  cost:['costs','cost','cost','costing'], hit:['hits','hit','hit','hitting'], hurt:['hurts','hurt','hurt','hurting'],
  let:['lets','let','let','letting'], shut:['shuts','shut','shut','shutting'], spread:['spreads','spread','spread','spreading'],
  burst:['bursts','burst','burst','bursting'], cast:['casts','cast','cast','casting'], bend:['bends','bent','bent','bending'],
  lend:['lends','lent','lent','lending'], blow:['blows','blew','blown','blowing'], freeze:['freezes','froze','frozen','freezing'],
  awake:['awakes','awoke','awoken','awaking'], wake:['wakes','woke','woken','waking'], arise:['arises','arose','arisen','arising'],
  lay:['lays','laid','laid','laying'], lie:['lies','lay','lain','lying'], light:['lights','lit/lighted','lit/lighted','lighting'],
  shine:['shines','shone','shone','shining'], shoot:['shoots','shot','shot','shooting'], slide:['slides','slid','slid','sliding'],
  spin:['spins','spun','spun','spinning'], split:['splits','split','split','splitting'], stick:['sticks','stuck','stuck','sticking'],
  sting:['stings','stung','stung','stinging'], swing:['swings','swung','swung','swinging'], dig:['digs','dug','dug','digging'],
  feed:['feeds','fed','fed','feeding'], flee:['flees','fled','fled','fleeing'], forbid:['forbids','forbade','forbidden','forbidding'],
  forgive:['forgives','forgave','forgiven','forgiving'], grind:['grinds','ground','ground','grinding'], hang:['hangs','hung','hung','hanging'],
  hide:['hides','hid','hidden','hiding'], lean:['leans','leant/leaned','leant/leaned','leaning'], leap:['leaps','leapt/leaped','leapt/leaped','leaping'],
  quit:['quits','quit/quitted','quit/quitted','quitting'], rid:['rids','rid','rid','ridding'], sew:['sews','sewed','sewn/sewed','sewing'],
  shave:['shaves','shaved','shaven/shaved','shaving'], shed:['sheds','shed','shed','shedding'], shrink:['shrinks','shrank/shrunk','shrunk','shrinking'],
  sink:['sinks','sank/sunk','sunk','sinking'], smell:['smells','smelt/smelled','smelt/smelled','smelling'],
  spring:['springs','sprang','sprung','springing'], stink:['stinks','stank','stunk','stinking'], strive:['strives','strove','striven','striving'],
  sweep:['sweeps','swept','swept','sweeping'], thrust:['thrusts','thrust','thrust','thrusting'], upset:['upsets','upset','upset','upsetting'],
  withdraw:['withdraws','withdrew','withdrawn','withdrawing'], withhold:['withholds','withheld','withheld','withholding'],
  undergo:['undergoes','underwent','undergone','undergoing'], undertake:['undertakes','undertook','undertaken','undertaking'],
  overcome:['overcomes','overcame','overcome','overcoming'], overlook:['overlooks','overlooked','overlooked','overlooking'],
  outgrow:['outgrows','outgrew','outgrown','outgrowing'], rewrite:['rewrites','rewrote','rewritten','rewriting'],
  rebuild:['rebuilds','rebuilt','rebuilt','rebuilding'], rethink:['rethinks','rethought','rethought','rethinking'],
  redo:['redoes','redid','redone','redoing'], repay:['repays','repaid','repaid','repaying'], mislead:['misleads','misled','misled','misleading'],
  misunderstand:['misunderstands','misunderstood','misunderstood','misunderstanding'], foresee:['foresees','foresaw','foreseen','foreseeing'],
  forecast:['forecasts','forecast/forecasted','forecast/forecasted','forecasting'], broadcast:['broadcasts','broadcast','broadcast','broadcasting'],
  bind:['binds','bound','bound','binding'], bleed:['bleeds','bled','bled','bleeding'], breed:['breeds','bred','bred','breeding'],
  burn:['burns','burnt/burned','burnt/burned','burning'], dream:['dreams','dreamt/dreamed','dreamt/dreamed','dreaming'],
  dwell:['dwells','dwelt/dwelled','dwelt/dwelled','dwelling'], kneel:['kneels','knelt/kneeled','knelt/kneeled','kneeling'],
  spell:['spells','spelt/spelled','spelt/spelled','spelling'], spoil:['spoils','spoilt/spoiled','spoilt/spoiled','spoiling']
};

/* ---------- 不规则形容词: base → [比较级, 最高级] ---------- */
const ADJ_IRREG = {
  good:['better','best'], bad:['worse','worst'], little:['less','least'],
  many:['more','most'], much:['more','most'], far:['farther/further','farthest/furthest'],
  old:['older/elder','oldest/eldest']
};

/* 规则动词变化 */
function regVerbForms(base){
  let s;
  if(/(s|x|z|ch|sh|o)$/.test(base)) s = base+'es';
  else if(/[^aeiou]y$/.test(base)) s = base.slice(0,-1)+'ies';
  else s = base+'s';
  const yEnd = /[^aeiou]y$/.test(base);
  const stem = yEnd ? base.slice(0,-1)+'i' : base;
  let past = base.endsWith('e') ? base+'d' : (yEnd ? stem+'ed' : base+'ed');
  let ing = base.endsWith('e') ? base.slice(0,-1)+'ing' : base+'ing';
  // CVC 双写（run→running, stop→stopped）
  if(/[^aeiou][aeiou][^aeiouwxy]$/.test(base)){
    past = base + base[base.length-1] + 'ed';
    ing = base + base[base.length-1] + 'ing';
  }
  return {s, past, pp:past, ing};
}

/* 规则形容词比较级/最高级 */
function adjForms(base){
  if(/[^aeiou][aeiou][^aeiouwxy]$/.test(base)) return {c:base+base[base.length-1]+'er', s:base+base[base.length-1]+'est'};
  if(/[^aeiou]y$/.test(base)){ const st = base.slice(0,-1); return {c:st+'ier', s:st+'iest'}; }
  if(base.endsWith('e')) return {c:base+'r', s:base+'st'};
  const vowels = (base.match(/[aeiouy]+/g)||[]).length;
  if(vowels>=3 || base.length>=9 || /(ful|less|ous|ive|ing|ed|able|ible|al|ic|ent|ant)$/.test(base)) return {c:'more '+base, s:'most '+base};
  return {c:base+'er', s:base+'est'};
}

document.addEventListener('DOMContentLoaded', ()=>App.boot());
