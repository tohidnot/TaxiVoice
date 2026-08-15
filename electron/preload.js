const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("taxiVoice", {
  desktop: true,
});
