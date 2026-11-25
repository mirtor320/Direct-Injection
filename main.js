const { app, BrowserWindow, dialog, ipcMain, Tray, Menu } = require('electron');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const net = require('net');
const chokidar = require('chokidar');
const FormData = require('form-data');
const { exec } = require('child_process');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
// Configurazione auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

if (process.env.NODE_ENV !== 'production') {
  autoUpdater.forceDevUpdateConfig = true;
}

autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow;
let tray = null;
let watchers = []; // Array di watcher attivi (uno per cartella)
let config = {};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const getResourcePath = (relativePath) => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, relativePath);
  } else {
    return path.join(__dirname, relativePath);
  }
};

// Scambia il codice generato da LogiFlow con la configurazione (LogiFlowDirectInjectionController.Attiva)
const URL_ATTIVAZIONE = 'https://web.spedireonline.cloud/globaltrs/api/v1/logiflow/direct-injection/attiva';

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

console.log('📁 Percorsi applicazione:');
console.log('   - App Path:', app.getAppPath());
console.log('   - User Data:', app.getPath('userData'));
console.log('   - Is Packaged:', app.isPackaged);
console.log('   - Config File:', CONFIG_FILE);

// --- GESTIONE CONFIGURAZIONE ---
function caricaConfigurazione() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      config = JSON.parse(content);

      // Migrazione backward: se esiste solo config.folder legacy, convertilo in folders[]
      if (!config.folders) {
        config.folders = [];
        if (config.folder) {
          config.folders.push({ folderPath: config.folder, workflow: 'DANEA' });
        }
      }

      console.log('✅ Configurazione caricata:', CONFIG_FILE);
    } catch (e) {
      console.error('❌ Errore lettura config:', e.message);
      config = getDefaultConfig();
    }
  } else {
    console.log('⚠️ Config non trovata, uso default');
    config = getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    folders: [],          // Array di { folderPath, workflow }
    endpoint: '',
    token: '',
    referenceId: '',
    servizio: '',
    printEndpoint: '',
    autoprint: false,
    printerName: '',
    labelWidth: 100,
    labelHeight: 150,
    savePDF: false
  };
}

function salvaConfigurazione() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('✅ Configurazione salvata:', CONFIG_FILE);
  } catch (e) {
    console.error('❌ Errore salvataggio config:', e.message);
  }
}

// --- UTILITY PER STAMPA RAW TCP ---
function isIpPrinterTarget(target) {
  if (!target) return false;
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(target.trim());
}

function sendRawTcp(buffer, target) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = target.split(':');
    const port = Number(portStr || 9100);

    console.log(`🌐 Invio RAW TCP a ${host}:${port} (${buffer.length} bytes)`);

    const socket = new net.Socket();
    socket.setTimeout(10000);

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`TCP timeout verso ${host}:${port}`));
    });

    socket.on('error', (err) => {
      console.error(`❌ Errore socket TCP: ${err.message}`);
      reject(err);
    });

    socket.connect(port, host, () => {
      console.log(`✅ Connesso a ${host}:${port}`);
      socket.write(buffer, (err) => {
        if (err) {
          socket.destroy();
          return reject(err);
        }
        console.log(`📤 Dati inviati con successo (${buffer.length} bytes)`);
        socket.end();
        resolve(true);
      });
    });

    socket.on('close', () => {
      console.log(`🔌 Connessione TCP chiusa con ${host}:${port}`);
    });
  });
}

// --- LOGICA DI STAMPA ---
async function stampaNativa(base64Content, printerName, numeroDocumento) {
  return new Promise((resolve, reject) => {
    try {
      if (!printerName || printerName.trim() === '') {
        const errMsg = '❌ Nome stampante non specificato';
        console.error(errMsg);
        return reject(new Error(errMsg));
      }

      const buffer = Buffer.from(base64Content, 'base64');
      const isPDF = buffer.slice(0, 4).toString() === '%PDF';

      const targetPrinter = printerName.trim();
      const extension = isPDF ? 'pdf' : 'zpl';
      const tempPath = path.join(app.getPath('temp'), `print_${Date.now()}.${extension}`);

      fs.writeFileSync(tempPath, buffer);
      console.log(`💾 File temporaneo creato: ${tempPath} (${buffer.length} bytes, tipo: ${isPDF ? 'PDF' : 'ZPL'})`);

      let command;
      let useTcp = false;

      if (isPDF) {
        if (process.platform === 'win32') {
          const pdfToPrinterPaths = [
            getResourcePath('tools/PDFtoPrinter.exe'),
            path.join(__dirname, 'tools', 'PDFtoPrinter.exe'),
            'C:\\Program Files\\PDFtoPrinter\\PDFtoPrinter.exe',
            'C:\\Program Files (x86)\\PDFtoPrinter\\PDFtoPrinter.exe'
          ];

          const pdfToPrinterPath = pdfToPrinterPaths.find(p => fs.existsSync(p));

          if (pdfToPrinterPath) {
            command = `"${pdfToPrinterPath}" "${tempPath}" "${targetPrinter}"`;
          } else {
            command = `powershell -Command "Start-Process -FilePath '${tempPath}' -Verb Print -WindowStyle Hidden"`;
            console.warn('⚠️ PDFtoPrinter non trovato. Usando PowerShell (stampante predefinita).');
          }
        } else {
          command = `lpr -P "${targetPrinter}" "${tempPath}"`;
        }
      } else {
        console.log(`🏷️ Rilevato formato ZPL/Raw per stampante "${targetPrinter}"`);

        if (isIpPrinterTarget(targetPrinter)) {
          useTcp = true;
          sendRawTcp(buffer, targetPrinter)
            .then(() => {
              setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) { } }, 2000);
              console.log('✅ Stampa ZPL via TCP completata con successo');
              resolve(true);
            })
            .catch((err) => {
              console.error(`❌ Errore stampa TCP: ${err.message}`);
              reject(err);
            });

          return;
        }

        if (process.platform === 'win32') {
          command = `copy /b "${tempPath}" "\\\\%COMPUTERNAME%\\${targetPrinter}"`;
        } else {
          command = `lpr -P "${targetPrinter}" -o raw "${tempPath}"`;
        }
      }

      if (!useTcp) {
        exec(command, (error, stdout, stderr) => {
          setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) { } }, 5000);

          if (stdout && stdout.trim()) console.log(`📋 STDOUT: ${stdout.trim()}`);
          if (stderr && stderr.trim()) console.warn(`⚠️ STDERR: ${stderr.trim()}`);

          if (error) {
            console.error(`❌ Errore esecuzione comando (exit code: ${error.code}): ${error.message}`);
            reject(error);
          } else {
            console.log('✅ Stampa inviata con successo');
            resolve(true);
          }
        });
      }
    } catch (err) {
      console.error(`❌ Errore nella funzione stampaNativa: ${err.message}`);
      reject(err);
    }
  });
}

async function processaSpedizioni(spedizioni, fileName) {
  if (!config.autoprint || spedizioni.length === 0) return;

  console.log(`📦 Inizio processamento ${spedizioni.length} etichette`);

  const labels = await richiediEtichettaStampa(spedizioni);
  if (!labels) {
    console.warn('⚠️ Nessuna etichetta ricevuta dal server');
    return;
  }

  console.log(`📥 Ricevute ${labels.length} etichette dal server`);

  for (const label of labels) {
    if (label.success && label.labelBase64) {
      try {
        if (config.savePDF) {
          const saveFolder = path.join(app.getPath('userData'), 'etichette_salvate');
          if (!fs.existsSync(saveFolder)) fs.mkdirSync(saveFolder, { recursive: true });

          const buffer = Buffer.from(label.labelBase64, 'base64');
          const isPDF = buffer.slice(0, 4).toString() === '%PDF';
          const ext = isPDF ? 'pdf' : 'zpl';
          const savePath = path.join(saveFolder, `${label.numeroDocumento}.${ext}`);

          fs.writeFileSync(savePath, buffer);
          console.log(`💾 Etichetta salvata: ${savePath}`);

          if (mainWindow) {
            mainWindow.webContents.send('stampa-completata', {
              idsped: label.idsped,
              numeroDocumento: label.numeroDocumento,
              success: true,
              mode: 'saved'
            });
          }
        } else {
          console.log(`🖨️ Invio etichetta ${label.numeroDocumento} alla stampante...`);
          await stampaNativa(label.labelBase64, config.printerName, label.numeroDocumento);

          if (mainWindow) {
            mainWindow.webContents.send('stampa-completata', {
              idsped: label.idsped,
              numeroDocumento: label.numeroDocumento,
              success: true,
              mode: 'printed'
            });
          }
        }
      } catch (err) {
        console.error(`❌ Errore processamento etichetta ${label.numeroDocumento}:`, err.message);

        if (mainWindow) {
          mainWindow.webContents.send('stampa-completata', {
            idsped: label.idsped,
            numeroDocumento: label.numeroDocumento,
            success: false,
            error: err.message
          });
        }
      }
    }
  }

  console.log(`✅ Processamento etichette completato`);
}

async function richiediEtichettaStampa(spedizioni) {
  try {
    const payload = {
      referenceId: config.referenceId,
      spedizioni: spedizioni.map(s => ({ idsped: s.idsped, numeroDocumento: s.numeroDocumento }))
    };

    console.log(`📡 Richiesta etichette a ${config.printEndpoint}`);

    const response = await axios.post(config.printEndpoint, payload, {
      headers: {
        'BSSI-TokenKey': config.token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      httpsAgent: httpsAgent,
      timeout: 60000
    });

    if (response.data?.success) {
      console.log(`✅ Etichette ricevute (${response.data.labels?.length || 0} items)`);
      return response.data.labels;
    } else {
      console.error('❌ Server ha risposto con success=false:', response.data);
      return null;
    }
  } catch (err) {
    console.error('❌ Errore richiesta etichetta:', err.response?.status, err.message);
    if (mainWindow) {
      mainWindow.webContents.send('log-debug', {
        tipo: 'error',
        msg: `Errore Etichette: ${err.message}`
      });
    }
    return null;
  }
}

// =====================================================
// INVIO FILE (XML o PDF) — logica comune
// XML: il server crea una spedizione per documento.
// PDF: il server lo legge (servizio Direct Injection, quota mensile) e crea la spedizione.
// =====================================================
async function inviaFile(filePath, workflowCartella) {
  const isPdf = path.extname(filePath).toLowerCase() === '.pdf';
  // Le cartelle nascono con workflow DANEA, che vale per gli XML: i PDF hanno sempre il loro
  const workflow = isPdf ? 'PDF' : workflowCartella;

  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').substring(0, 15);
  const casuale = crypto.randomBytes(3).toString('hex'); // due file nello stesso secondo non si sovrascrivono sul server
  const referenceId = config.referenceId || '0000';
  const contentType = isPdf ? 'application/pdf' : 'application/xml';
  const fileName = `${referenceId}_${workflow}_${timestamp}_${casuale}${isPdf ? '.pdf' : '.defxml'}`;

  const documentMetadata = {
    document: {
      referenceId: referenceId,
      name: fileName,
      servizio: config.servizio || '',
      contentType: contentType,
      meta: { imageType: '', imageIndex: '' }
    },
    rules: { workflowName: workflow, estraiDati: isPdf, creaSpedizione: isPdf }
  };

  const form = new FormData();
  form.append('document', JSON.stringify(documentMetadata));
  form.append('attachment', fs.createReadStream(filePath), {
    filename: fileName,
    contentType: contentType
  });

  console.log(`📤 Invio ${isPdf ? 'PDF' : 'XML'} [${workflow}] → ${config.endpoint}...`);

  let response;
  try {
    response = await axios.post(config.endpoint, form, {
      headers: {
        ...form.getHeaders(),
        'BSSI-TokenKey': config.token,
        'User-Agent': 'Mozilla/5.0'
      },
      httpsAgent: httpsAgent,
      timeout: isPdf ? 180000 : 60000 // la lettura di un PDF scansionato e' lenta
    });
  } catch (err) {
    const message = err.response?.data?.message;
    throw message ? new Error(message) : err;
  }

  if (isPdf) {
    const quota = response.data?.quota;
    if (quota && mainWindow) {
      mainWindow.webContents.send('log-debug', {
        tipo: quota.restanti <= 3 ? 'warning' : 'info',
        msg: `📊 PDF letti questo mese: ${quota.usati} di ${quota.limite}`
      });
    }
    // Un server senza la creazione da PDF risponde success con 0 spedizioni: il PDF non va cancellato
    if (response.data?.success && !(response.data.spedizioni?.length > 0)) {
      throw new Error('PDF ricevuto ma nessuna spedizione creata');
    }
  }

  return response;
}

// =====================================================
// AVVIO MONITORAGGIO MULTI-CARTELLA
// =====================================================
function fermaMonitoraggio() {
  if (watchers.length > 0) {
    console.log(`🔄 Chiudo ${watchers.length} watcher attivi...`);
    watchers.forEach(w => w.close());
    watchers = [];
  }
}

function avviaMonitoraggio() {
  fermaMonitoraggio();

  const folders = config.folders || [];

  if (folders.length === 0 || !config.endpoint || !config.token) {
    console.warn('⚠️ Monitoraggio non avviato: nessuna cartella configurata o parametri mancanti');
    return;
  }

  console.log(`👁️ Avvio monitoraggio su ${folders.length} cartella/e`);

  folders.forEach(({ folderPath, workflow }) => {
    if (!folderPath || !fs.existsSync(folderPath)) {
      console.warn(`⚠️ Cartella non trovata, skip: ${folderPath}`);
      return;
    }

    console.log(`   📂 [${workflow}] → ${folderPath}`);

    const watcher = chokidar.watch(folderPath, {
      persistent: true,
      depth: 0,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
    });

    watcher.on('add', async (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const supportedExts = ['.defxml', '.pdf'];

      if (!supportedExts.includes(ext)) return;

      console.log(`📄 Nuovo file [${ext}]: ${path.basename(filePath)}`);

      if (mainWindow) {
        mainWindow.webContents.send('log-debug', {
          tipo: 'info',
          msg: `📄 Rilevato: ${path.basename(filePath)} [${workflow}]`
        });
      }

      try {
        const response = await inviaFile(filePath, workflow);

        if (response.data && response.data.success) {
          const nSped = response.data.numeroSpedizioniCreate || 0;
          console.log(`✅ File processato: ${nSped} spedizioni create`);

          if (mainWindow) {
            mainWindow.webContents.send('file-processato', {
              fileName: path.basename(filePath),
              workflow: workflow,
              folderPath: folderPath,
              numeroSpedizioni: nSped,
              spedizioni: response.data.spedizioni
            });
          }

          if (response.data.spedizioni) {
            try {
              await processaSpedizioni(response.data.spedizioni, path.basename(filePath));
            } catch (printErr) {
              // La spedizione c'e' gia': il file non va in errori, altrimenti si reinvia e si duplica
              console.error('❌ Errore stampa:', printErr.message);
              if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'error', msg: `Errore stampa: ${printErr.message}` });
            }
          }

          fs.unlinkSync(filePath);
          console.log(`🗑️ File eliminato: ${path.basename(filePath)}`);
        } else {
          throw new Error(response.data?.message || 'Errore server');
        }
      } catch (err) {
        console.error('❌ Errore invio:', err.message);

        if (mainWindow) {
          mainWindow.webContents.send('log-debug', {
            tipo: 'error',
            msg: `❌ Errore [${path.basename(filePath)}]: ${err.message}`
          });
        }

        // Sposta in cartella errori locale alla cartella monitorata
        const errorFolder = path.join(folderPath, 'errori');
        if (!fs.existsSync(errorFolder)) fs.mkdirSync(errorFolder, { recursive: true });
        try {
          const nome = path.parse(filePath);
          let destinazione = path.join(errorFolder, nome.base);
          if (fs.existsSync(destinazione)) destinazione = path.join(errorFolder, `${nome.name}_${Date.now()}${nome.ext}`);
          fs.renameSync(filePath, destinazione);
          console.log(`📁 File spostato in: ${errorFolder}`);
        } catch (moveErr) {
          console.error(`❌ Impossibile spostare il file: ${moveErr.message}`);
        }
      }
    });

    watcher.on('error', (error) => {
      console.error(`❌ Errore watcher [${folderPath}]:`, error);
    });

    watchers.push(watcher);
  });

  console.log(`✅ Monitoraggio avviato su ${watchers.length} cartella/e`);

  if (mainWindow) {
    mainWindow.webContents.send('monitoraggio-avviato', {
      count: watchers.length,
      folders: folders
    });
  }
}

function createWindow() {
  caricaConfigurazione();
  mainWindow = new BrowserWindow({
    width: 850, height: 750,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const indexPath = path.join(__dirname, 'index.html');
  mainWindow.loadFile(indexPath);

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('config-caricata', config);
    avviaMonitoraggio();
  });
}

// =====================================================
// IPC HANDLERS
// =====================================================
ipcMain.on('salva-config', (event, data) => {
  console.log('💾 Salvataggio configurazione...');

  config.endpoint = data.endpoint;
  config.token = data.token;
  config.referenceId = data.referenceId;
  config.servizio = data.servizio;
  config.printEndpoint = data.printEndpoint || '';
  config.autoprint = data.autoprint || false;
  config.printerName = data.printerName || '';
  config.savePDF = data.savePDF || false;
  config.labelSize = data.labelSize || '10x15';

  // Aggiorna array cartelle
  if (Array.isArray(data.folders)) {
    config.folders = data.folders;
  }

  if (data.labelSize === 'custom') {
    config.labelWidth = (data.customWidth * 10) || 100;
    config.labelHeight = (data.customHeight * 10) || 150;
  } else {
    const sizes = {
      '10x15': { width: 100, height: 150 },
      '10x10': { width: 100, height: 100 },
      '10x20': { width: 100, height: 200 }
    };
    const size = sizes[data.labelSize] || sizes['10x15'];
    config.labelWidth = size.width;
    config.labelHeight = size.height;
  }

  salvaConfigurazione();
  avviaMonitoraggio();
});

// Attivazione con il codice di LogiFlow. Il codice vale una volta sola: la configurazione si salva subito.
ipcMain.handle('attiva-codice', async (event, codice) => {
  const c = String(codice || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length !== 8) return { ok: false, message: 'Il codice di attivazione ha 8 caratteri (XXXX-XXXX).' };

  let response;
  try {
    response = await axios.get(URL_ATTIVAZIONE, {
      params: { codice: `${c.slice(0, 4)}-${c.slice(4)}` },
      // La risposta contiene la chiave del cliente: qui il certificato si verifica
      httpsAgent: new https.Agent({ rejectUnauthorized: true }),
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000
    });
  } catch (err) {
    console.error('❌ Errore attivazione:', err.response?.status, err.message);
    return { ok: false, message: err.response?.data?.message || `Attivazione non riuscita: ${err.message}` };
  }

  const r = response.data && response.data.configurazione;
  if (!r || !r.endpoint || !r.token) return { ok: false, message: 'Risposta del server non valida.' };

  const ricevuti = {
    endpoint: r.endpoint,
    printEndpoint: r.printEndpoint || '',
    sendLdvEndpoint: r.sendLdvEndpoint || '',
    token: r.token,
    referenceId: r.referenceId || '',
    servizio: r.servizio || ''
  };
  Object.assign(config, ricevuti);
  salvaConfigurazione();
  avviaMonitoraggio();
  console.log('✅ App attivata con codice');
  return { ok: true, configurazione: ricevuti };
});

// Apri dialog per selezionare una nuova cartella da aggiungere
ipcMain.handle('seleziona-cartella', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Seleziona cartella da monitorare'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Mantenuto per backward compat (vecchio pulsante "Cambia Cartella")
ipcMain.on('richiesta-cambio-cartella', () => {
  dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      // Aggiunge come prima cartella (sostituisce se già presente una sola)
      if (!config.folders) config.folders = [];
      if (config.folders.length === 0) {
        config.folders.push({ folderPath: result.filePaths[0], workflow: 'DANEA' });
      } else {
        config.folders[0].folderPath = result.filePaths[0];
      }
      salvaConfigurazione();
      avviaMonitoraggio();
      mainWindow.webContents.send('config-caricata', config);
    }
  });
});

// Auto-updater events
autoUpdater.on('checking-for-update', () => {
  console.log('🔍 Controllo aggiornamenti...');
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'info', msg: '🔍 Controllo aggiornamenti...' });
});

autoUpdater.on('update-available', (info) => {
  console.log(`🚀 Aggiornamento disponibile: v${info.version}`);
  if (mainWindow) {
    mainWindow.webContents.send('log-debug', { tipo: 'warning', msg: `🚀 Aggiornamento disponibile: v${info.version}` });
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Aggiornamento Disponibile',
      message: `È disponibile la versione ${info.version}`,
      detail: 'Vuoi scaricare e installare l\'aggiornamento ora?',
      buttons: ['Sì, aggiorna', 'No, più tardi'],
      defaultId: 0, cancelId: 1
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.downloadUpdate();
        mainWindow.webContents.send('log-debug', { tipo: 'info', msg: '📥 Download aggiornamento...' });
      }
    });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('✅ App già aggiornata');
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'info', msg: '✅ App già aggiornata' });
});

autoUpdater.on('error', (err) => {
  console.error('❌ Errore aggiornamento:', err.message);
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'error', msg: `❌ Errore: ${err.message}` });
});

autoUpdater.on('download-progress', (progressObj) => {
  const msg = `📥 Download: ${progressObj.percent.toFixed(2)}%`;
  console.log(msg);
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'info', msg });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`🎁 Aggiornamento scaricato: v${info.version}`);
  if (mainWindow) {
    mainWindow.webContents.send('log-debug', { tipo: 'success', msg: '🎁 Aggiornamento scaricato' });
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Aggiornamento Pronto',
      message: 'L\'aggiornamento è pronto',
      detail: 'Riavviare ora per installare?',
      buttons: ['Riavvia ora', 'Più tardi'],
      defaultId: 0, cancelId: 1
    }).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  }
});

ipcMain.handle('get-printers', async () => {
  return (await mainWindow.webContents.getPrintersAsync()).map(p => p.name);
});

ipcMain.on('check-for-updates', () => {
  console.log('🔍 Controllo manuale aggiornamenti');
  autoUpdater.checkForUpdates();
});

app.whenReady().then(() => {
  createWindow();
  setTimeout(() => {
    console.log('🚀 Avvio controllo aggiornamenti...');
    autoUpdater.checkForUpdates();
  }, 5000);
});