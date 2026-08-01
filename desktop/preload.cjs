// The only bridge between the page and the shell.
//
// The window runs with contextIsolation on and nodeIntegration off, which is
// the right posture — the page loads a local dev server and must never get
// Node. So instead of exposing anything general, this publishes three named
// calls and nothing else. The page cannot run a command of its own choosing;
// it can only ask for a service by name, and main.cjs decides what that means.
//
// Why this exists at all: installing the WhatsApp service means ~525 MB of
// Chromium, which nobody should pay for on first run when most people never
// open Outreach. Only the shell can run npm, so the page needs a way to say
// "the operator has actually asked for WhatsApp now".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nyyonDesktop', {
  // Marks this as the desktop app rather than a browser tab. The SPA runs in
  // both, and in a browser there is no shell to install anything, so the UI
  // has to know which one it is in.
  isDesktop: true,

  // { installed, running } for a bundled service.
  serviceStatus: (name) => ipcRenderer.invoke('service:status', name),

  // Installs and starts it. Resolves { ok } or { ok:false, error }. Slow by
  // nature — the caller should be showing progress from onServiceProgress.
  installService: (name) => ipcRenderer.invoke('service:install', name),

  // Progress while an install runs. Returns an unsubscribe function, so a
  // React effect can clean up without leaking a listener per mount.
  onServiceProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('service:progress', handler);
    return () => ipcRenderer.removeListener('service:progress', handler);
  },
});
