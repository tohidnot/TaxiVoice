const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 8787;
const ROOT = path.join(__dirname, "..");
let backend = null;
let win = null;

function pythonBin() {
  return process.env.TAXIVOICE_PYTHON || "python3";
}

function startBackend() {
  backend = spawn(
    pythonBin(),
    ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(PORT), "--reload"],
    {
      cwd: path.join(ROOT, "backend"),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  backend.stdout.on("data", (d) => process.stdout.write(`[api] ${d}`));
  backend.stderr.on("data", (d) => process.stderr.write(`[api] ${d}`));
  backend.on("exit", (code) => {
    backend = null;
    if (code && win) {
      console.error("backend exited", code);
    }
  });
}

function waitForHealth(tries = 80) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else if (n <= 0) reject(new Error("backend not healthy"));
        else setTimeout(() => tick(n - 1), 250);
      });
      req.on("error", () => {
        if (n <= 0) reject(new Error("backend did not start"));
        else setTimeout(() => tick(n - 1), 250);
      });
    };
    tick(tries);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    title: "TaxiVoice",
    backgroundColor: "#ffffff",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(async () => {
  startBackend();
  await waitForHealth();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backend) {
    backend.kill("SIGTERM");
    backend = null;
  }
});
