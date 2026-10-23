'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function invoke(action, value) {
  const result = await ipcRenderer.invoke(`steam-desk:${action}`, value);
  if (!result || !result.ok) {
    const error = new Error(result?.error?.message || '操作失败，请重试。');
    error.code = result?.error?.code || 'internal';
    throw error;
  }
  return result.value;
}

contextBridge.exposeInMainWorld('steamDesk', Object.freeze({
  account: () => invoke('account'),
  login: () => invoke('login'),
  logout: () => invoke('logout'),
  inventory: (value) => invoke('inventory', value),
  listings: () => invoke('listings'),
  price: (value) => invoke('price', value),
  previewSell: (value) => invoke('previewSell', value),
  previewRemove: (value) => invoke('previewRemove', value),
  execute: (value) => invoke('execute', value),
  stop: () => invoke('stop'),
  status: () => invoke('status'),
  exportLog: () => invoke('exportLog'),
  openExternal: (value) => invoke('openExternal', value),
  setDemo: (value) => invoke('setDemo', value),
  onProgress: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('steam-desk:progress', listener);
    return () => ipcRenderer.removeListener('steam-desk:progress', listener);
  }
}));
