const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('__mupdf', {
  desktop: true,
  // 拿到磁盘真实路径（替代已移除的 File.path），PDF 由主进程按路径直接打开
  pathForFile: (f)=>{ try{ return webUtils.getPathForFile(f); }catch(e){ return null; } },
  openPath: (p)=>ipcRenderer.invoke('mupdf:openPath', p),
  render: (id, pageNum, scale)=>ipcRenderer.invoke('mupdf:render', id, pageNum, scale),
  close: (id)=>ipcRenderer.invoke('mupdf:close', id)
});
