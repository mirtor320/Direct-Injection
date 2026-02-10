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
const { autoUpdater } = require('electron-updater');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

let mainWindow;
let tray = null;
let watcher = null;
let config = {};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');

// --- GESTIONE CONFIGURAZIONE ---
function caricaConfigurazione() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
      config = JSON.parse(content);
    } catch (e) { config = getDefaultConfig(); }
  } else { config = getDefaultConfig(); }
}

function getDefaultConfig() {
  return {
    folder: '', endpoint: '', token: '', referenceId: '', servizio: '',
    printEndpoint: '', autoprint: false, printerName: '',
    labelWidth: 100, labelHeight: 150, savePDF: false
  };
}

function salvaConfigurazione() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// --- UTILITY PER STAMPA RAW TCP ---
/**
 * Verifica se il target è un indirizzo IP (con porta opzionale)
 * Es: "192.168.1.50" o "192.168.1.50:9100"
 */
function isIpPrinterTarget(target) {
  if (!target) return false;
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(target.trim());
}

/**
 * Invia dati RAW via TCP/IP alla stampante (tipicamente porta 9100)
 */
function sendRawTcp(buffer, target) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = target.split(':');
    const port = Number(portStr || 9100);

    console.log(`🌐 Invio RAW TCP a ${host}:${port} (${buffer.length} bytes)`);

    const socket = new net.Socket();
    socket.setTimeout(10000); // 10 secondi timeout

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

// --- LOGICA DI STAMPA E PROCESSO ---
async function stampaNativa(base64Content, printerName, numeroDocumento) {
  return new Promise((resolve, reject) => {
    try {
      // Validazione preventiva
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
        // --- GESTIONE PDF ---
        if (process.platform === 'win32') {
          const pdfToPrinterPaths = [
            path.join(__dirname, 'tools', 'PDFtoPrinter.exe'),
            'C:\\Program Files\\PDFtoPrinter\\PDFtoPrinter.exe',
            'C:\\Program Files (x86)\\PDFtoPrinter\\PDFtoPrinter.exe'
          ];
          const pdfToPrinterPath = pdfToPrinterPaths.find(p => fs.existsSync(p));

          if (pdfToPrinterPath) {
            command = `"${pdfToPrinterPath}" "${tempPath}" "${targetPrinter}"`;
            console.log(`📄 Stampa PDF con PDFtoPrinter su "${targetPrinter}"`);
          } else {
            command = `powershell -Command "Start-Process -FilePath '${tempPath}' -Verb Print -WindowStyle Hidden"`;
            console.warn('⚠️ PDFtoPrinter non trovato. Usando PowerShell (stampante predefinita).');
          }
        } else {
          command = `lpr -P "${targetPrinter}" "${tempPath}"`;
          console.log(`📄 Stampa PDF con lpr su "${targetPrinter}"`);
        }
      } else {
        // --- GESTIONE ZPL (RAW) ---
        console.log(`🏷️ Rilevato formato ZPL/Raw per stampante "${targetPrinter}"`);

        // Strategia 1: Se il printerName è un IP, usa TCP diretto
        if (isIpPrinterTarget(targetPrinter)) {
          useTcp = true;
          console.log(`🌐 Stampante rilevata come IP: ${targetPrinter}. Uso invio RAW TCP.`);

          sendRawTcp(buffer, targetPrinter)
            .then(() => {
              // Cleanup tempfile
              setTimeout(() => {
                try { fs.unlinkSync(tempPath); } catch (e) { }
              }, 2000);
              console.log('✅ Stampa ZPL via TCP completata con successo');
              resolve(true);
            })
            .catch((err) => {
              console.error(`❌ Errore stampa TCP: ${err.message}`);
              reject(err);
            });

          return; // Esce dalla Promise, non esegue exec
        }

        // Strategia 2: Usa comandi OS (Windows/Linux)
        if (process.platform === 'win32') {
          // Su Windows: tentativo copy /b (richiede share)
          command = `copy /b "${tempPath}" "\\\\%COMPUTERNAME%\\${targetPrinter}"`;
          console.warn(`⚠️ Uso copy /b per ZPL. NOTA: la stampante "${targetPrinter}" deve essere condivisa con questo nome.`);
        } else {
          // Su Linux/Mac: lpr con opzione raw
          command = `lpr -P "${targetPrinter}" -o raw "${tempPath}"`;
          console.log(`🏷️ Stampa ZPL con lpr -o raw su "${targetPrinter}"`);
        }
      }

      // Se non usa TCP, esegue il comando shell
      if (!useTcp) {
        console.log(`🔧 Eseguo comando: ${command}`);

        exec(command, (error, stdout, stderr) => {
          // Cleanup tempfile dopo 5 secondi
          setTimeout(() => {
            try { fs.unlinkSync(tempPath); } catch (e) { }
          }, 5000);

          // Log completo output
          if (stdout && stdout.trim()) {
            console.log(`📋 STDOUT: ${stdout.trim()}`);
          }
          if (stderr && stderr.trim()) {
            console.warn(`⚠️ STDERR: ${stderr.trim()}`);
          }

          if (error) {
            console.error(`❌ Errore esecuzione comando (exit code: ${error.code}): ${error.message}`);

            // Messaggio specifico per ZPL su Windows
            if (!isPDF && process.platform === 'win32') {
              console.warn('💡 Tip per stampa ZPL su Windows:');
              console.warn('   1. Condividi la stampante con il nome esatto usato in printerName');
              console.warn('   2. OPPURE usa l\'indirizzo IP della stampante (es: "192.168.1.50")');
              console.warn('   3. Verifica che la porta 9100 sia accessibile (ping + telnet)');
            }

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

  console.log(`📦 Inizio processamento ${spedizioni.length} etichette (autoprint=${config.autoprint})`);

  // Usa la tua funzione originale per richiedere le etichette
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
          // Modalità: salva su disco
          const saveFolder = path.join(config.folder, 'etichette_salvate');
          if (!fs.existsSync(saveFolder)) fs.mkdirSync(saveFolder);

          const buffer = Buffer.from(label.labelBase64, 'base64');
          const isPDF = buffer.slice(0, 4).toString() === '%PDF';
          const ext = isPDF ? 'pdf' : 'zpl';
          const savePath = path.join(saveFolder, `${label.numeroDocumento}.${ext}`);

          fs.writeFileSync(savePath, buffer);
          console.log(`💾 Etichetta salvata: ${savePath}`);

          // Notifica successo all'UI
          if (mainWindow) {
            mainWindow.webContents.send('stampa-completata', {
              idsped: label.idsped,
              numeroDocumento: label.numeroDocumento,
              success: true,
              mode: 'saved'
            });
          }
        } else {
          // Modalità: stampa diretta
          console.log(`🖨️ Invio etichetta ${label.numeroDocumento} alla stampante...`);
          await stampaNativa(label.labelBase64, config.printerName, label.numeroDocumento);

          // Notifica successo all'UI
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

        // Notifica errore all'UI
        if (mainWindow) {
          mainWindow.webContents.send('stampa-completata', {
            idsped: label.idsped,
            numeroDocumento: label.numeroDocumento,
            success: false,
            error: err.message
          });
        }
      }
    } else {
      console.warn(`⚠️ Etichetta non valida o mancante per ${label.numeroDocumento || 'sconosciuto'}`);

      // Notifica errore all'UI
      if (mainWindow && label.idsped) {
        mainWindow.webContents.send('stampa-completata', {
          idsped: label.idsped,
          numeroDocumento: label.numeroDocumento || 'N/A',
          success: false,
          error: 'Etichetta non valida o base64 mancante'
        });
      }
    }
  }

  console.log(`✅ Processamento etichette completato`);
}

// --- FUNZIONE ORIGINALE RICHIEDI ETICHETTA ---
async function richiediEtichettaStampa(spedizioni) {
  try {
    const payload = {
      referenceId: config.referenceId,
      spedizioni: spedizioni.map(s => ({ idsped: s.idsped, numeroDocumento: s.numeroDocumento }))
    };

    console.log(`📡 Richiesta etichette a ${config.printEndpoint} per ${spedizioni.length} spedizioni`);

    const response = await axios.post(config.printEndpoint, payload, {
      headers: {
        'BSSI-TokenKey': config.token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      httpsAgent: httpsAgent,
      timeout: 60000
    });

    if (response.data?.success) {
      console.log(`✅ Etichette ricevute con successo (${response.data.labels?.length || 0} items)`);
      return response.data.labels;
    } else {
      console.error('❌ Server ha risposto con success=false:', response.data);
      return null;
    }
  } catch (err) {
    console.error('❌ Errore richiesta etichetta:', err.response?.status, err.response?.data || err.message);
    if (mainWindow) {
      mainWindow.webContents.send('log-debug', {
        tipo: 'error',
        msg: `Errore Etichette (${err.response?.status || 'network'}): ${JSON.stringify(err.response?.data || err.message)}`
      });
    }
    return null;
  }
}

// --- MONITORAGGIO CON LOGICA ORIGINALE (METADATA + RINOMINA) ---
function avviaMonitoraggio(folderPath) {
  if (!folderPath || !config.endpoint || !config.token) {
    console.warn('⚠️ Monitoraggio non avviato: folder, endpoint o token mancanti');
    return;
  }

  if (watcher) {
    console.log('🔄 Chiudo watcher precedente...');
    watcher.close();
  }

  console.log(`👁️ Avvio monitoraggio cartella: ${folderPath}`);

  watcher = chokidar.watch(folderPath, {
    persistent: true,
    depth: 0,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
  });

  watcher.on('add', async filePath => {
    if (path.extname(filePath).toLowerCase() === '.defxml') {
      console.log(`📄 Nuovo file rilevato: ${path.basename(filePath)}`);

      const now = new Date();
      const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '_').substring(0, 15);
      const referenceId = config.referenceId || '0000';
      const fileName = `${referenceId}_DANEA_${timestamp}.defxml`;

      const documentMetadata = {
        document: {
          referenceId: referenceId,
          name: fileName,
          servizio: config.servizio || "",
          contentType: "application/xml",
          meta: { imageType: "", imageIndex: "" }
        },
        rules: { workflowName: "DANEA" }
      };

      const form = new FormData();
      form.append('document', JSON.stringify(documentMetadata));
      form.append('attachment', fs.createReadStream(filePath), {
        filename: fileName,
        contentType: "application/xml"
      });

      try {
        console.log(`📤 Invio file a ${config.endpoint}...`);

        const response = await axios.post(config.endpoint, form, {
          headers: {
            ...form.getHeaders(),
            'BSSI-TokenKey': config.token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          httpsAgent: httpsAgent,
          timeout: 60000
        });

        if (response.data && response.data.success) {
          console.log(`✅ File processato con successo: ${response.data.numeroSpedizioniCreate || 0} spedizioni create`);

          if (mainWindow) {
            mainWindow.webContents.send('file-processato', {
              fileName: fileName,
              numeroSpedizioni: response.data.numeroSpedizioniCreate,
              spedizioni: response.data.spedizioni
            });
          }

          if (response.data.spedizioni) {
            await processaSpedizioni(response.data.spedizioni, fileName);
          }

          fs.unlinkSync(filePath); // Elimina file processato
          console.log(`🗑️ File eliminato: ${filePath}`);
        } else {
          console.error('❌ Errore server (success=false):', response.data);
          if (mainWindow) {
            mainWindow.webContents.send('log-debug', {
              tipo: 'error',
              msg: `Errore Server: ${JSON.stringify(response.data)}`
            });
          }
          throw new Error(response.data?.message || 'Errore sconosciuto dal server');
        }
      } catch (err) {
        console.error('❌ Errore invio:', err.response?.status, err.response?.data || err.message);

        if (mainWindow) {
          mainWindow.webContents.send('log-debug', {
            tipo: 'error',
            msg: `Errore Invio (${err.response?.status || 'network'}): ${JSON.stringify(err.response?.data || err.message)}`
          });
        }

        // Sposta in cartella errori (tua logica originale)
        const errorFolder = path.join(folderPath, 'errori');
        if (!fs.existsSync(errorFolder)) fs.mkdirSync(errorFolder);
        const errorPath = path.join(errorFolder, path.basename(filePath));
        fs.renameSync(filePath, errorPath);
        console.log(`📁 File spostato in cartella errori: ${errorPath}`);
      }
    }
  });

  watcher.on('error', error => {
    console.error('❌ Errore watcher:', error);
  });
}

// --- RESTO DEL CODICE (IPC E WINDOW) ---
function createWindow() {
  caricaConfigurazione();
  mainWindow = new BrowserWindow({
    width: 800, height: 700,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('config-caricata', config);
    if (config.folder) avviaMonitoraggio(config.folder);
  });
}

ipcMain.on('salva-config', (event, data) => {
  console.log('💾 Salvataggio configurazione...');

  // Preserva la cartella monitorata
  config.folder = data.folder || config.folder;

  config.endpoint = data.endpoint;
  config.token = data.token;
  config.referenceId = data.referenceId;
  config.servizio = data.servizio;
  config.printEndpoint = data.printEndpoint || '';
  config.autoprint = data.autoprint || false;
  config.printerName = data.printerName || '';
  config.savePDF = data.savePDF || false;

  // Salva il formato etichetta
  config.labelSize = data.labelSize || '10x15';

  // Gestisci le dimensioni personalizzate (converti da cm a mm)
  if (data.labelSize === 'custom') {
    config.labelWidth = (data.customWidth * 10) || 100;
    config.labelHeight = (data.customHeight * 10) || 150;
  } else {
    // Imposta dimensioni predefinite in base al formato selezionato
    const sizes = {
      '10x15': { width: 100, height: 150 },
      '10x10': { width: 100, height: 100 },
      '10x20': { width: 100, height: 200 }
    };
    const size = sizes[data.labelSize] || sizes['10x15'];
    config.labelWidth = size.width;
    config.labelHeight = size.height;
  }

  salvaConfigurazione(); // Questa funzione scrive fisicamente sul disco
  console.log('✅ Configurazione salvata:', {
    folder: config.folder,
    printerName: config.printerName,
    autoprint: config.autoprint,
    savePDF: config.savePDF
  });

  // Notifica al watcher di ripartire sulla nuova (o vecchia) cartella
  if (config.folder) {
    avviaMonitoraggio(config.folder);
  }
});

// --- GESTIONE AGGIORNAMENTI ---
autoUpdater.on('checking-for-update', () => {
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'info', msg: '🔍 Controllo aggiornamenti...' });
});

autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'warning', msg: `🚀 Aggiornamento disponibile: v${info.version}. Download in corso...` });
});

autoUpdater.on('update-not-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'info', msg: '✅ L\'app è aggiornata.' });
});

autoUpdater.on('error', (err) => {
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'error', msg: `❌ Errore aggiornamento: ${err.message}` });
});

autoUpdater.on('download-progress', (progressObj) => {
  let logMsg = `📥 Download: ${progressObj.percent.toFixed(2)}%`;
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'info', msg: logMsg });
});

autoUpdater.on('update-downloaded', (info) => {
  if (mainWindow) mainWindow.webContents.send('log-debug', { tipo: 'success', msg: '🎁 Aggiornamento scaricato. L\'app si riavvierà per installarlo...' });
  setTimeout(() => {
    autoUpdater.quitAndInstall();
  }, 5000);
});

ipcMain.on('richiesta-cambio-cartella', () => {
  dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      config.folder = result.filePaths[0];
      salvaConfigurazione();
      mainWindow.webContents.send('cartella-selezionata', config.folder);
      avviaMonitoraggio(config.folder);
    }
  });
});

ipcMain.handle('get-printers', async () => {
  return (await mainWindow.webContents.getPrintersAsync()).map(p => p.name);
});

app.whenReady().then(() => {
  createWindow();
  // Controlla aggiornamenti dopo 3 secondi dall'avvio
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 3000);
});