'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
  submit: (licenseKey) => ipcRenderer.send('license:submit', licenseKey),
  cancel: () => ipcRenderer.send('license:cancel'),
  retry: () => ipcRenderer.send('license:retry'),
  onPrefillError: (callback) =>
    ipcRenderer.on('license:prefill-error', (_event, message) => callback(message)),
});
