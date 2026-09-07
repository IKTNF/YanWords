// 打包前把 www 与 server 复制进 app 目录
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', 'approot');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
function cp(src, dst){
  const st = fs.statSync(src);
  if(st.isDirectory()){
    fs.mkdirSync(dst, { recursive: true });
    for(const f of fs.readdirSync(src)) cp(path.join(src, f), path.join(dst, f));
  }else{
    fs.copyFileSync(src, dst);
  }
}
cp(path.join(ROOT, 'www'), path.join(OUT, 'www'));
for(const f of ['server.js', 'server.py', '启动.bat', '使用说明.md', '测试资料.txt', 'README.md', 'LICENSE']){
  const s = path.join(ROOT, f);
  if(fs.existsSync(s)) fs.copyFileSync(s, path.join(OUT, f));
}
console.log('approot 已准备:', fs.readdirSync(OUT).join(', '));
