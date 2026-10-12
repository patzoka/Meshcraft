const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meshcraft", {
  saveStl: (name, data) => ipcRenderer.invoke("save-stl", name, data),
});
