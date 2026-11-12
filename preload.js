const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  convertFile: (opts) => ipcRenderer.invoke('convert-file', opts),
  cancelConversion: (filePath) => ipcRenderer.invoke('cancel-conversion', filePath),
  notify: (opts) => ipcRenderer.invoke('notify', opts),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),
  onProgress: (cb) => ipcRenderer.on('convert-progress', (_, data) => cb(data)),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  showInFinder: (filePath) => ipcRenderer.invoke('show-in-finder', filePath),
  openImageDialog: () => ipcRenderer.invoke('open-image-dialog'),
});
