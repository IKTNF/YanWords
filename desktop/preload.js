const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__mupdf', {
  desktop: true,
  open: (bytes)=>ipcRenderer.invoke('mupdf:open', bytes),
  render: (id, pageNum, scale)=>ipcRenderer.invoke('mupdf:render', id, pageNum, scale),
  close: (id)=>ipcRenderer.invoke('mupdf:close', id)
});
