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

async function youdao(q){
  const u = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(q)
    + '&dicts=' + encodeURIComponent(JSON.stringify({count:99, dicts:[["ec","blng_sents_part","web_trans"]]}));
  const r = await fetch(u, {
    headers: { 'User-Agent': UA, 'Referer': 'https://dict.youdao.com/' },
    signal: AbortSignal.timeout(10000)
  });
  if(!r.ok) throw new Error('youdao HTTP ' + r.status);
  return await r.json();
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
      const data = await youdao(q);
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
