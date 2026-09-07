/* 研词助手 · 本地服务（静态文件 + 有道词典在线代理） */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'www');
const PORT = parseInt(process.env.PORT || '8765', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.otf':'font/otf', '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2',
  '.wasm':'application/wasm', '.traineddata':'application/octet-stream',
  '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.txt':'text/plain; charset=utf-8', '.md':'text/plain; charset=utf-8'
};

function inRoot(p){ const r = path.resolve(p); return r === ROOT || r.startsWith(ROOT + path.sep); }

/* ---- 有道 jsonapi：解析成统一格式 ---- */
function parseYoudao(d){
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
}

async function youdaoParsed(q){
  const u = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(q)
    + '&dicts=' + encodeURIComponent(JSON.stringify({count:99, dicts:[["ec","blng_sents_part","web_trans"]]}));
  const r = await fetch(u, {
    headers: { 'User-Agent': UA, 'Referer': 'https://dict.youdao.com/' },
    signal: AbortSignal.timeout(6000)
  });
  if(!r.ok) throw new Error('youdao HTTP ' + r.status);
  const p = parseYoudao(await r.json());
  if(!p.senses.length) throw new Error('youdao empty');
  return { source:'youdao', phonetic:p.phonetic, senses:p.senses.slice(0,20) };
}

/* ---- 必应词典：兜底源，HTML 解析 ---- */
async function bingParsed(q){
  const r = await fetch('https://cn.bing.com/dict/search?q=' + encodeURIComponent(q), {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(6000)
  });
  if(!r.ok) throw new Error('bing HTTP ' + r.status);
  const html = await r.text();
  const senses = [];
  const re = /<span class="pos"[^>]*>([^<]+)<\/span>\s*<span class="def[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while((m = re.exec(html)) && senses.length < 12){
    const def = String(m[2]).replace(/<[^>]+>/g,'').replace(/&nbsp;|&#160;/g,' ').replace(/\s+/g,' ').trim();
    if(def) senses.push(m[1].trim()+' '+def);
  }
  if(!senses.length) throw new Error('bing empty');
  let phonetic = '';
  const pm = html.match(/class="(?:hd_prUS|pr b_primtxt|hd_pr)[^"]*"[^>]*>\s*([^<]{1,40})\s*</);
  if(pm) phonetic = pm[1].trim();
  return { source:'bing', phonetic, senses };
}

/* ---- 翻译：有道 fanyi（sign）/ QQ 翻译 ---- */
async function youdaoTranslate(q, to){
  const crypto = require('crypto');
  const ts = String(Date.now());
  const salt = ts + Math.floor(Math.random()*10);
  const sign = crypto.createHash('md5').update('fanyideskweb' + q + salt + 'Ygy_4c=r#e#4EX^NUGUc5').digest('hex');
  const body = new URLSearchParams({
    i: q, from: 'auto', to: to==='en' ? 'en' : 'zh-CHS', smartresult: 'dict',
    client: 'fanyideskweb', salt, sign, lts: ts,
    bv: crypto.createHash('md5').update(UA).digest('hex'),
    doctype: 'json', version: '2.1', keyfrom: 'fanyi.web', action: 'FY_BY_REALTlME'
  });
  const r = await fetch('https://fanyi.youdao.com/translate_o?smartresult=dict&smartresult=rule', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': 'https://fanyi.youdao.com/', 'Origin': 'https://fanyi.youdao.com' },
    body,
    signal: AbortSignal.timeout(6000)
  });
  if(!r.ok) throw new Error('youdao-tr HTTP ' + r.status);
  const d = await r.json();
  if(!d || d.errorCode !== 0 || !d.translateResult) throw new Error('youdao-tr empty');
  const text = d.translateResult.map(seg=>seg.map(s=>s.tgt).join('')).join('\n');
  if(!text.trim()) throw new Error('youdao-tr empty');
  return { source: 'youdao', text };
}

async function qqTranslate(q, to){
  const r = await fetch('https://fanyi.qq.com/api/translate', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'auto', target: to==='en' ? 'en' : 'zh', sourceText: q, qtv: '', qtk: '', sessionUuid: 'translate_uuid' + Date.now() }),
    signal: AbortSignal.timeout(6000)
  });
  if(!r.ok) throw new Error('qq-tr HTTP ' + r.status);
  const d = await r.json();
  const text = d && d.translate && d.translate.records ? d.translate.records.map(x=>x.targetText||'').join('\n') : '';
  if(!text.trim()) throw new Error('qq-tr empty');
  return { source: 'qq', text };
}

const server = http.createServer(async (req, res)=>{
  try{
    const u = new URL(req.url, 'http://127.0.0.1');
    let p;
    try{ p = decodeURIComponent(u.pathname); }catch(e){ p = u.pathname; }

    if(p.startsWith('/api/dict')){
      const q = (u.searchParams.get('q')||'').trim();
      if(!q){
        res.writeHead(400, {'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({error:'缺少参数 q'}));
        return;
      }
      // 多源兜底：有道 → 必应，确保在线查询尽快出结果
      let data = null;
      try{ data = await youdaoParsed(q); }catch(e){ console.log('youdao fail:', e.message); }
      if(!data){
        try{ data = await bingParsed(q); }catch(e){ console.log('bing fail:', e.message); }
      }
      if(!data){
        res.writeHead(502, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({error:'在线词典暂时不可用（已尝试有道/必应），请使用内置离线词库'}));
        return;
      }
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(data));
      return;
    }
    if(p.startsWith('/api/translate')){
      const q = (u.searchParams.get('q')||'').trim();
      const to = (u.searchParams.get('to')||'zh-CN').trim();
      if(!q){
        res.writeHead(400, {'Content-Type':'application/json; charset=utf-8'});
        res.end(JSON.stringify({error:'缺少参数 q'}));
        return;
      }
      // 多源尝试在线翻译：有道 → QQ；都失败则返回离线提示由前端做逐词对照
      let data = null;
      try{ data = await youdaoTranslate(q, to); }catch(e){ console.log('youdao-tr fail:', e.message); }
      if(!data){
        try{ data = await qqTranslate(q, to); }catch(e){ console.log('qq-tr fail:', e.message); }
      }
      if(!data){
        // 无在线翻译源可用：200 + offline 标记，由前端做离线对照（避免浏览器报 502 噪音）
        res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({offline:true, error:'在线翻译接口不可用，将使用离线逐词对照'}));
        return;
      }
      res.writeHead(200, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(data));
      return;
    }
    if(p === '/api/health'){
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{"ok":true}');
      return;
    }
    if(p === '/') p = '/index.html';
    const fp = path.join(ROOT, p.replace(/^\/+/, ''));
    if(!inRoot(fp) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()){
      res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'});
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream'});
    fs.createReadStream(fp).pipe(res);
  }catch(e){
    res.writeHead(500, {'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({error:String(e && e.message || e)}));
  }
});

server.on('error', e=>{
  if(e.code === 'EADDRINUSE'){
    console.error('端口 ' + PORT + ' 被占用，请关闭占用该端口的程序后重试。');
  }else{
    console.error(e);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', ()=>{
  console.log('');
  console.log('  📖 研词助手 · 考研英语一词汇工作台 已启动');
  console.log('  地址: http://127.0.0.1:' + PORT + '/');
  console.log('  关闭本窗口（Ctrl+C）即退出程序。');
  console.log('');
});
