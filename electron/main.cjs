const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: "#11151c",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

ipcMain.handle("save-stl", async (_event, suggestedName, data) => {
  if (typeof suggestedName !== "string" || !(data instanceof ArrayBuffer)) {
    throw new TypeError("Invalid STL save request.");
  }

  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName,
    filters: [{ name: "STL model", extensions: ["stl"] }],
  });
  if (result.canceled || !result.filePath) return false;

  const fs = require("node:fs/promises");
  await fs.writeFile(result.filePath, Buffer.from(data));
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
