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
  const serverPath = path.join(app.getAppPath(), 'approot', 'server.js');
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

/* 按文件路径直接打开（桌面版专用）：大 PDF 不再整文件读入内存/IPC 拷贝 */
ipcMain.handle('mupdf:openPath', async (e, filePath)=>{
  try{
    const M = await loadMupdf();
    if(typeof filePath !== 'string' || !filePath) return { error: '文件路径无效' };
    if(!fs.existsSync(filePath)) return { error: '文件不存在或已被移动' };
    const doc = M.Document.openDocument(filePath, 'application/pdf');
    if(!doc || doc.countPages() < 1) return { error: '打开失败' };
    const id = nextId++;
    docCache.set(id, doc);
    return { ok: true, id, pages: doc.countPages() };
  }catch(err){
    return { error: String(err && err.message || err) };
  }
});

ipcMain.handle('mupdf:render', async (e, id, pageNum, scale)=>{
  try{
    const M = await loadMupdf();
    const doc = docCache.get(id);
    if(!doc) return { error: '文档不存在' };
    const page = doc.loadPage(pageNum - 1);
    const pix = page.toPixmap(M.Matrix.scale(scale, scale), M.ColorSpace.DeviceRGB, false, true);
    const png = pix.asPNG();
    return { ok: true, w: pix.getWidth(), h: pix.getHeight(), png: Buffer.from(png) };
  }catch(err){
    return { error: String(err && err.message || err) };
  }
});

ipcMain.handle('mupdf:close', (e, id)=>{
  const d = docCache.get(id);
  if(d){ try{ d.destroy(); }catch(_){} docCache.delete(id); }
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

/* 退出前统一释放 MuPDF 文档，避免残留 */
app.on('before-quit', ()=>{
  for(const d of docCache.values()){ try{ d.destroy(); }catch(_){} }
  docCache.clear();
});
