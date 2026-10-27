/* 研词助手 桌面版主进程：内嵌本地服务 + MuPDF 原生渲染桥接 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWin = null;
let server = null;
let mupdf = null;
let docCache = new Map();
let nextId = 1;

/* ---- 启动本地服务（复用 server.js，serve www 静态文件与在线词典代理） ---- */
function startServer(){
  const appPath = app.getAppPath();
  // 优先打包后的 approot/server.js；源码开发模式（未 prepack）直接复用根目录 server.js
  const serverPath = fs.existsSync(path.join(appPath, 'approot', 'server.js'))
    ? path.join(appPath, 'approot', 'server.js')
    : path.join(appPath, 'server.js');
  try{
    server = require(serverPath);
  }catch(e){
    console.error('本地服务启动失败:', e);
    return Promise.reject(e);
  }
  return new Promise((resolve, reject)=>{
    if(server && server.listening){
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
    setTimeout(resolve, 5000); // 兜底
  });
}

/* ---- MuPDF 桥接 ---- */
async function loadMupdf(){
  if(mupdf) return mupdf;
  mupdf = await import('mupdf');
  return mupdf;
}

/*
 * 按需流式打开：mupdf.js 的 openDocument(路径) 内部是 readFileSync 整份读入再拷进
 * WASM 堆（897MB 文件 ≈ 2.6GB 峰值），必须改为 JS 流回调（fd + pread）——MuPDF 只
 * 请求它当前需要的字节，打开 7ms、渲染 60 页仅从磁盘读约 120MB。
 */
function openLazyDoc(M, filePath){
  const fd = fs.openSync(filePath, 'r');
  const size = fs.fstatSync(fd).size;
  let closed = false;
  const closeFd = ()=>{ if(closed) return; closed = true; try{ fs.closeSync(fd); }catch(_){} };
  const handle = {
    fileSize(){ return size; },
    read(heap, addr, len, pos){
      const avail = Math.max(0, Math.min(len, size - pos));
      if(avail <= 0) return 0;
      return fs.readSync(fd, heap, addr, avail, pos);   // 直接读入 WASM 堆，零额外拷贝
    },
    close: closeFd
  };
  try{
    const stream = new M.Stream(handle);
    const doc = M.Document.openDocument(stream, 'application/pdf');
    return { doc, stream, handle };
  }catch(err){
    closeFd();          // 打开失败时不能把 fd 留在外面
    throw err;
  }
}

function closeDocEntry(entry){
  if(!entry) return;
  try{ entry.doc && entry.doc.destroy(); }catch(_){}
  try{ entry.handle && entry.handle.close(); }catch(_){}
  entry.doc = null; entry.stream = null;
}

/* 按文件路径流式打开；极小文件若流式失败再回退整份读取 */
ipcMain.handle('mupdf:openPath', async (e, filePath)=>{
  try{
    const M = await loadMupdf();
    if(typeof filePath !== 'string' || !filePath) return { error: '文件路径无效' };
    if(!fs.existsSync(filePath)) return { error: '文件不存在或已被移动' };
    let entry = null;
    try{
      entry = openLazyDoc(M, filePath);
      if(!entry.doc || entry.doc.countPages() < 1) throw new Error('打开失败');
    }catch(err){
      closeDocEntry(entry);
      if(fs.statSync(filePath).size > 256*1024*1024) throw err;   // 大文件不做回退，避免爆内存
      const doc = M.Document.openDocument(filePath, 'application/pdf');
      entry = { doc, stream: null, handle: null };
    }
    const pages = entry.doc.countPages();
    const id = nextId++;
    docCache.set(id, entry);
    return { ok: true, id, pages };
  }catch(err){
    return { error: String(err && err.message || err) };
  }
});

ipcMain.handle('mupdf:render', async (e, id, pageNum, scale)=>{
  const M = await loadMupdf();
  const entry = docCache.get(id);
  if(!entry || !entry.doc) return { error: '文档不存在' };
  let page = null, pix = null;
  try{
    page = entry.doc.loadPage(pageNum - 1);
    pix = page.toPixmap(M.Matrix.scale(scale, scale), M.ColorSpace.DeviceRGB, false, true);
    const png = pix.asPNG();
    return { ok: true, w: pix.getWidth(), h: pix.getHeight(), png: Buffer.from(png) };
  }catch(err){
    return { error: String(err && err.message || err) };
  }finally{
    // 必须显式释放，否则 MuPDF 内部缓存会随翻页线性增长（30 页即可到 249MB）
    try{ if(pix) pix.destroy(); }catch(_){}
    try{ if(page) page.destroy(); }catch(_){}
    try{ M.shrinkStore(); }catch(_){}
  }
});

ipcMain.handle('mupdf:close', (e, id)=>{
  const entry = docCache.get(id);
  if(entry){ closeDocEntry(entry); docCache.delete(id); }
  return true;
});

/* ---- 窗口 ---- */
function createWindow(){
  mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: '研词助手 · 考研英语一词汇工作台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.webContents.setWindowOpenHandler(()=>({ action: 'deny' }));
  mainWin.loadURL('http://127.0.0.1:8765/');
  mainWin.on('closed', ()=>{ mainWin = null; });
}

const gotLock = app.requestSingleInstanceLock();
if(!gotLock){
  app.quit();
}else{
  app.on('second-instance', ()=>{
    if(mainWin){
      if(mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
  app.whenReady().then(async ()=>{
    try{ await startServer(); }catch(e){ console.error(e); }
    createWindow();
    app.on('activate', ()=>{
      if(BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', ()=>{
  if(server){ try{ server.close(); }catch(_){} }
  app.quit();
});

/* 退出前统一释放 MuPDF 文档（含文件句柄），避免残留 */
app.on('before-quit', ()=>{
  for(const entry of docCache.values()) closeDocEntry(entry);
  docCache.clear();
  try{ if(mupdf && mupdf.emptyStore) mupdf.emptyStore(); }catch(_){}
});
