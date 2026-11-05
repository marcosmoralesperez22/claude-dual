'use strict';

// Puente mínimo entre la barra lateral (src/) y el proceso principal.
// Solo se expone esta API; la UI no tiene acceso a Node ni a ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const plain = (data) => ({
  name: String(data?.name ?? ''),
  color: String(data?.color ?? ''),
  initial: String(data?.initial ?? ''),
});

contextBridge.exposeInMainWorld('claudeDual', {
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => subscribe('state', callback),
  onEditRequest: (callback) => subscribe('edit:open', callback),

  switchTo: (id) => ipcRenderer.send('account:switch', String(id)),
  showAccountMenu: (id) => ipcRenderer.send('account:menu', String(id)),
  addAccount: (data) => ipcRenderer.invoke('account:add', plain(data)),
  updateAccount: (id, data) => ipcRenderer.invoke('account:update', String(id), plain(data)),
  removeAccount: (id) => ipcRenderer.invoke('account:remove', String(id)),

  setOverlay: (on) => ipcRenderer.send('overlay:set', Boolean(on)),
  reload: () => ipcRenderer.send('view:reload'),
});
