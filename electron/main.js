// Voice Changer — Electron main process
// Spawns the Python backend server, waits for it to become ready,
// then opens the voice changer UI in a BrowserWindow.

const { app, BrowserWindow, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration — must match server/settings.py defaults
// ---------------------------------------------------------------------------
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 18888;
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 180000; // 3 minutes — first launch downloads weights

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let mainWindow = null;
let pythonProcess = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getServerDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, '..', 'server');
}

// ---------------------------------------------------------------------------
// Python detection
// ---------------------------------------------------------------------------

/**
 * Locate a usable Python interpreter.
 * Priority: venv inside server/ → system "python"
 */
function findPython() {
  const venvPython = path.join(
    getServerDir(), 'venv', 'Scripts', 'python.exe'
  );
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }

  // Fallback: system Python
  try {
    execSync('python --version', { stdio: 'ignore' });
    return 'python';
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

/**
 * Spawn the Python voice changer server as a child process.
 * Returns the ChildProcess handle, or null on failure.
 */
function spawnBackend() {
  const pythonPath = findPython();
  if (!pythonPath) {
    dialog.showErrorBox(
      'Python Not Found',
      'Could not find a Python interpreter.\n\n'
      + 'Please install Python 3.10 and set up the virtual environment:\n'
      + '  cd server\n'
      + '  python -m venv venv\n'
      + '  .\\venv\\Scripts\\activate.ps1\n'
      + '  pip install -r requirements-common.txt -r requirements-dml.txt'
    );
    app.quit();
    return null;
  }

  const serverDir = getServerDir();
  const mainScript = path.join(serverDir, 'main.py');

  console.log(`[electron] Starting backend: ${pythonPath} ${mainScript}`);
  console.log(`[electron] Working directory: ${serverDir}`);

  const proc = spawn(pythonPath, [mainScript], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Forward backend output to the Electron console
  proc.stdout.on('data', (data) => {
    process.stdout.write(`[server] ${data}`);
  });
  proc.stderr.on('data', (data) => {
    process.stderr.write(`[server] ${data}`);
  });

  proc.on('error', (err) => {
    console.error('[electron] Failed to spawn backend:', err);
    if (!isQuitting) {
      dialog.showErrorBox(
        'Backend Error',
        `Failed to start the voice changer backend:\n${err.message}`
      );
      app.quit();
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[electron] Backend exited: code=${code} signal=${signal}`);
    if (!isQuitting && code !== null && code !== 0) {
      dialog.showErrorBox(
        'Backend Crashed',
        `The voice changer backend exited unexpectedly (code ${code}).\n\n`
        + 'Check the server console output or server/vcclient.log for details.'
      );
      app.quit();
    }
  });

  return proc;
}

/**
 * Kill the Python backend process tree.
 * On Windows, `taskkill /T /F` ensures uvicorn child processes are also terminated.
 */
function killBackend() {
  if (!pythonProcess || pythonProcess.killed) return;

  console.log(`[electron] Stopping backend (PID ${pythonProcess.pid})...`);
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pythonProcess.pid} /t /f`, { stdio: 'ignore' });
    } else {
      pythonProcess.kill('SIGTERM');
    }
  } catch (err) {
    // Process may already be gone — that's fine
    console.warn('[electron] Kill backend warning:', err.message);
  }
  pythonProcess = null;
}

// ---------------------------------------------------------------------------
// Server readiness polling
// ---------------------------------------------------------------------------

/**
 * Poll the backend server until it responds to HTTP requests.
 * Resolves when the server is ready, rejects on timeout.
 */
function waitForServer() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const poll = () => {
      // If the python process died during polling, stop immediately
      if (pythonProcess && pythonProcess.exitCode !== null) {
        reject(new Error('Backend process exited before the server became ready.'));
        return;
      }

      const req = http.get(SERVER_URL, (res) => {
        // Any response means the server is up
        res.resume(); // Consume response data to free memory
        console.log(`[electron] Server is ready (${Date.now() - startTime}ms)`);
        resolve();
      });

      req.on('error', () => {
        if (Date.now() - startTime > POLL_TIMEOUT_MS) {
          reject(new Error(
            `Server did not start within ${POLL_TIMEOUT_MS / 1000} seconds.\n\n`
            + 'This can happen if weight downloads are slow.\n'
            + 'Check server/vcclient.log for details.'
          ));
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      });

      req.setTimeout(POLL_INTERVAL_MS, () => {
        req.destroy();
      });
    };

    // Start polling after a brief initial delay to let the process spin up
    setTimeout(poll, 500);
  });
}

// ---------------------------------------------------------------------------
// Window management
// ---------------------------------------------------------------------------

function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    resizable: false,
    frame: false,
    icon: path.join(getServerDir(), 'vc_64.ico'),
    title: 'Voice Changer',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'loading.html'));
  win.show();
  return win;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(getServerDir(), 'vc_64.ico'),
    title: 'Voice Changer',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(SERVER_URL);
  win.show();

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('ready', async () => {
  // Show loading splash while backend starts
  const loadingWindow = createLoadingWindow();

  // Spawn the Python backend
  pythonProcess = spawnBackend();
  if (!pythonProcess) {
    loadingWindow.close();
    return;
  }

  // Wait for server to become ready
  try {
    await waitForServer();
  } catch (err) {
    loadingWindow.close();
    dialog.showErrorBox('Startup Error', err.message);
    killBackend();
    app.quit();
    return;
  }

  // Server is ready — open the main window and close loading splash
  mainWindow = createMainWindow();
  loadingWindow.close();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  killBackend();
});
