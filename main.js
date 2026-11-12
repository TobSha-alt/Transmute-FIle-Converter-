const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function getFfmpegPath() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(bundled)) return bundled;
  }
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'ffmpeg.exe'
    ];
    for (const c of candidates) { if (fs.existsSync(c)) return c; }
    return 'ffmpeg.exe';
  }
  const candidates = ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return 'ffmpeg';
}

function checkVideoToolbox(ffmpegPath) {
  return new Promise(resolve => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-encoders']);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());
    proc.on('close', () => resolve({
      h264: out.includes('h264_videotoolbox'),
      hevc: out.includes('hevc_videotoolbox'),
    }));
    proc.on('error', () => resolve({ h264: false, hevc: false }));
  });
}

function probeFile(ffmpegPath, inputPath) {
  return new Promise(resolve => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', inputPath]);
    let out = '';
    proc.stderr.on('data', d => out += d.toString());
    proc.on('close', () => {
      const vMatch = out.match(/Video:\s+(\w+)/);
      const aMatch = out.match(/Audio:\s+(\w+)/);
      const dMatch = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
      let duration = null;
      if (dMatch) duration = parseInt(dMatch[1]) * 3600 + parseInt(dMatch[2]) * 60 + parseFloat(dMatch[3]);
      resolve({
        video: vMatch ? vMatch[1].toLowerCase() : null,
        audio: aMatch ? aMatch[1].toLowerCase() : null,
        duration,
      });
    });
    proc.on('error', () => resolve({ video: null, audio: null, duration: null }));
  });
}

// Codecs safe to stream-copy into MKV (it accepts almost everything)
const MKV_SAFE_VIDEO = ['h264','avc','hevc','h265','vp8','vp9','av1','mpeg4'];
const MKV_SAFE_AUDIO = ['aac','mp3','opus','flac','vorbis','ac3','eac3','pcm'];

function canCopy(codec, safeList) {
  if (!codec || !safeList) return false;
  return safeList.some(s => codec.includes(s));
}

function buildArgs(inputPath, outputPath, fmt, vtEncoders, sourceCodecs) {
  const base = ['-i', inputPath, '-y'];

  const IMAGE_FMTS = ['png','jpg','jpeg','webp','bmp','tiff'];
  const AUDIO_FMTS = ['mp3','aac','wav','flac','ogg','m4a'];

  if (IMAGE_FMTS.includes(fmt)) {
    if (fmt === 'jpg' || fmt === 'jpeg') return [...base, '-q:v', '2', outputPath];
    if (fmt === 'webp') return [...base, '-q:v', '80', outputPath];
    return [...base, outputPath];
  }

  if (fmt === 'gif') {
    return [...base, '-vf', 'fps=12,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', outputPath];
  }

  if (AUDIO_FMTS.includes(fmt)) {
    const audioEncoders = {
      mp3:  ['-c:a', 'libmp3lame', '-q:a', '2'],
      aac:  ['-c:a', 'aac', '-b:a', '192k'],
      m4a:  ['-c:a', 'aac', '-b:a', '192k'],
      wav:  ['-c:a', 'pcm_s16le'],
      flac: ['-c:a', 'flac'],
      ogg:  ['-c:a', 'libvorbis', '-q:a', '4'],
    };
    // Copy audio only if it already matches the target format
    const srcAudio = sourceCodecs ? sourceCodecs.audio : null;
    const copyAudio = (fmt === 'mp3' && srcAudio === 'mp3')
      || (fmt === 'flac' && srcAudio === 'flac')
      || ((fmt === 'aac' || fmt === 'm4a') && srcAudio && srcAudio.includes('aac'));
    if (copyAudio) return [...base, '-vn', '-c:a', 'copy', outputPath];
    return [...base, '-vn', ...(audioEncoders[fmt] || ['-c:a', 'aac', '-b:a', '192k']), outputPath];
  }

  // ── Video formats ──────────────────────────────────────────────────────────

  if (fmt === 'mkv') {
    // MKV accepts almost everything — copy what we can, transcode what we must
    const copyVideo = canCopy(sourceCodecs.video, MKV_SAFE_VIDEO);
    const copyAudio = canCopy(sourceCodecs.audio, MKV_SAFE_AUDIO);
    return [
      ...base,
      copyVideo ? '-c:v' : '-c:v', copyVideo ? 'copy' : (vtEncoders.h264 ? 'h264_videotoolbox' : 'libx264'),
      ...(copyVideo ? [] : (vtEncoders.h264 ? ['-q:v', '65'] : ['-crf', '23', '-preset', 'fast'])),
      copyAudio ? '-c:a' : '-c:a', copyAudio ? 'copy' : 'aac',
      ...(copyAudio ? [] : ['-b:a', '192k']),
      '-sn',
      outputPath,
    ];
  }

  if (fmt === 'webm') {
    // WebM only supports VP9+Opus — always re-encode
    return [...base, '-c:v', 'libvpx-vp9', '-crf', '33', '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k', '-sn', outputPath];
  }

  if (fmt === 'avi') {
    // AVI: use mpeg4 + mp3, widely compatible
    return [...base, '-c:v', 'mpeg4', '-q:v', '6', '-c:a', 'libmp3lame', '-q:a', '4', '-sn', outputPath];
  }

  if (fmt === 'mp4' || fmt === 'mov') {
    // Always re-encode to guarantee QuickTime/macOS compatibility.
    // Use VideoToolbox (hardware) for speed — hevc if source is hevc, otherwise h264.
    const srcVideo = sourceCodecs ? sourceCodecs.video : null;
    const isHevc = srcVideo && (srcVideo.includes('hevc') || srcVideo.includes('h265'));

    let videoArg;
    if (isHevc && vtEncoders.hevc) {
      videoArg = ['-c:v', 'hevc_videotoolbox', '-q:v', '65', '-tag:v', 'hvc1'];
    } else if (vtEncoders.h264) {
      videoArg = ['-c:v', 'h264_videotoolbox', '-q:v', '65'];
    } else {
      videoArg = ['-c:v', 'libx264', '-crf', '23', '-preset', 'fast'];
    }

    return [...base, ...videoArg, '-c:a', 'aac', '-b:a', '192k', '-sn', outputPath];
  }

  return [...base, outputPath];
}

// Map of filePath → active ffmpeg child process, so we can kill on cancel
const activeProcesses = new Map();

function runFfmpeg(ffmpeg, args, filePath, event) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args);
    activeProcesses.set(filePath, proc);
    let stderr = '';
    let duration = null;

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (!duration) {
        const m = chunk.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
        if (m) duration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      }
      const timeMatch = chunk.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (timeMatch && duration) {
        const current = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
        const progress = Math.min(99, Math.round((current / duration) * 100));
        event.sender.send('convert-progress', { filePath, progress });
      }
    });

    proc.on('close', (code) => {
      activeProcesses.delete(filePath);
      if (code === 0) resolve({ success: true, stderr });
      else resolve({ success: false, stderr });
    });
    proc.on('error', (err) => {
      activeProcesses.delete(filePath);
      resolve({ success: false, stderr: err.message });
    });
  });
}

const BLACK_PNG_B64 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// Document conversion functions
async function convertPdfToTxt(filePath, outputPath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    fs.writeFileSync(outputPath, data.text, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function convertDocxToTxt(filePath, outputPath) {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    fs.writeFileSync(outputPath, result.value, 'utf-8');
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function convertTextDocument(filePath, outputPath, targetFormat) {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  try {
    if (targetFormat === 'txt') {
      fs.writeFileSync(outputPath, content, 'utf-8');
      return { success: true };
    } else if (targetFormat === 'md') {
      fs.writeFileSync(outputPath, content, 'utf-8');
      return { success: true };
    } else if (targetFormat === 'rtf') {
      // Better RTF wrapper
      const escapedContent = content
        .replace(/\\/g, '\\\\')
        .replace(/{/g, '\\{')
        .replace(/}/g, '\\}')
        .replace(/\n/g, '\\par\r\n');
      const rtfContent = `{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat\\deflang1033{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}\r\n\\viewkind4\\uc1\\pard\\f0\\fs24 ${escapedContent}\r\n}`;
      fs.writeFileSync(outputPath, rtfContent, 'utf-8');
      return { success: true };
    } else if (targetFormat === 'html') {
      const htmlContent = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<title>${path.basename(filePath, path.extname(filePath))}</title>\n</head>\n<body>\n<pre>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>\n</body>\n</html>`;
      fs.writeFileSync(outputPath, htmlContent, 'utf-8');
      return { success: true };
    } else if (targetFormat === 'csv') {
      // Simple CSV conversion - each line becomes a row
      const lines = content.split('\n').filter(line => line.trim());
      const csvContent = lines.map(line => `"${line.replace(/"/g, '""')}"`).join('\n');
      fs.writeFileSync(outputPath, csvContent, 'utf-8');
      return { success: true };
    } else if (targetFormat === 'json') {
      const jsonContent = JSON.stringify({ content: content }, null, 2);
      fs.writeFileSync(outputPath, jsonContent, 'utf-8');
      return { success: true };
    } else if (targetFormat === 'xml') {
      const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>\n<document>\n  <content>${content.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/g, '&amp;')}</content>\n</document>`;
      fs.writeFileSync(outputPath, xmlContent, 'utf-8');
      return { success: true };
    }
    return { success: false, error: 'Unsupported target format' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

ipcMain.handle('convert-file', async (event, { filePath, targetFormat, outputDir, coverImage }) => {
  const ext = targetFormat.toLowerCase();
  const baseName = path.basename(filePath, path.extname(filePath));
  const outDir = outputDir || path.dirname(filePath);
  const outPath = path.join(outDir, `${baseName}_converted.${ext}`);

  const sourceExt = path.extname(filePath).toLowerCase();
  const DOC_INPUTS = ['.pdf', '.docx', '.txt', '.rtf', '.md', '.html', '.csv', '.json', '.xml'];
  const DOC_OUTPUTS = ['txt', 'md', 'rtf', 'html', 'csv', 'json', 'xml'];

  // Check if this is a document conversion
  if (DOC_INPUTS.includes(sourceExt) && DOC_OUTPUTS.includes(ext)) {
    // Simulate progress for document conversions
    const progressInterval = setInterval(() => {
      const currentProgress = Math.min(100, (activeProcesses.get(filePath)?.progress || 0) + 20);
      event.sender.send('convert-progress', { filePath, progress: currentProgress });
    }, 100);

    let result;
    if (sourceExt === '.pdf' && ext === 'txt') {
      result = await convertPdfToTxt(filePath, outPath);
    } else if (sourceExt === '.docx' && ext === 'txt') {
      result = await convertDocxToTxt(filePath, outPath);
    } else if (sourceExt === '.txt' || sourceExt === '.md' || sourceExt === '.rtf' || sourceExt === '.html' || sourceExt === '.csv' || sourceExt === '.json' || sourceExt === '.xml') {
      result = await convertTextDocument(filePath, outPath, ext);
    } else {
      result = { success: false, error: 'Unsupported document conversion' };
    }

    clearInterval(progressInterval);
    event.sender.send('convert-progress', { filePath, progress: 100 });

    if (result.success) {
      return { success: true, outputPath: outPath };
    } else {
      return { success: false, error: result.error };
    }
  }

  // Otherwise, use ffmpeg for media conversion
  const ffmpeg = getFfmpegPath();

  const [info, vtEncoders] = await Promise.all([
    probeFile(ffmpeg, filePath),
    process.platform === 'darwin' ? checkVideoToolbox(ffmpeg) : { h264: false, hevc: false },
  ]);

  // Build the base ffmpeg args
  const args = buildArgs(filePath, outPath, ext, vtEncoders, info);

  const AUDIO_FMTS = ['mp3','aac','wav','flac','ogg','m4a'];
  const IMAGE_FMTS = ['png','jpg','jpeg','webp','bmp','tiff'];
  const needsVideo = !AUDIO_FMTS.includes(ext);
  const needsAudio = !IMAGE_FMTS.includes(ext);
  const missingVideo = needsVideo && !info.video;
  const missingAudio = needsAudio && !info.audio;

  // Inject dummy streams for cross-category conversions
  if (missingVideo || missingAudio) {
    const dummyInputs = [];
    if (missingVideo) {
      const cover = coverImage || path.join(os.tmpdir(), '_fc_black.png');
      if (!coverImage) {
        try { fs.writeFileSync(cover, BLACK_PNG_B64); } catch {}
      }
      dummyInputs.push('-loop', '1', '-i', cover);
    }
    if (missingAudio) {
      dummyInputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    }
    args.splice(2, 0, ...dummyInputs);
    if (info.duration) args.splice(args.length - 1, 0, '-t', String(info.duration));
  }

  const result = await runFfmpeg(ffmpeg, args, filePath, event);

  // Fallback: if something failed, retry with safe software re-encode
  if (!result.success) {
    const fallbackArgs = buildArgs(filePath, outPath, ext, { h264: false, hevc: false }, info);
    if (missingVideo || missingAudio) {
      const dummyInputs = [];
      if (missingVideo) {
        const cover = coverImage || path.join(os.tmpdir(), '_fc_black.png');
        dummyInputs.push('-loop', '1', '-i', cover);
      }
      if (missingAudio) {
        dummyInputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      }
      fallbackArgs.splice(2, 0, ...dummyInputs);
      if (info.duration) fallbackArgs.splice(fallbackArgs.length - 1, 0, '-t', String(info.duration));
    }
    const fbResult = await runFfmpeg(ffmpeg, fallbackArgs, filePath, event);
    if (fbResult.success) return { success: true, outputPath: outPath };
    return { success: false, error: fbResult.stderr.slice(-500) };
  }

  return { success: true, outputPath: outPath };
});

ipcMain.handle('show-in-finder', (_, filePath) => {
  // showItemInFolder highlights the file; fall back to opening the folder if it fails
  try {
    shell.showItemInFolder(filePath);
  } catch {
    const folder = path.dirname(filePath);
    shell.openPath(folder);
  }
});

ipcMain.handle('cancel-conversion', (_, filePath) => {
  const proc = activeProcesses.get(filePath);
  if (proc) {
    proc.kill('SIGKILL');
    activeProcesses.delete(filePath);
  }
  return true;
});

ipcMain.handle('notify', (_, { title, body }) => {
  new Notification({ title, body }).show();
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All Supported', extensions: ['mp4','mov','avi','mkv','webm','gif','3gp','ts','m2ts','mp3','aac','wav','flac','ogg','m4a','wma','opus','aiff','png','jpg','jpeg','webp','bmp','tiff','heic','avif','ico','svg','pdf','docx','txt','rtf','md','html','csv','json','xml'] },
      { name: 'Video', extensions: ['mp4','mov','avi','mkv','webm','gif','3gp','ts','m2ts'] },
      { name: 'Audio', extensions: ['mp3','aac','wav','flac','ogg','m4a','wma','opus','aiff'] },
      { name: 'Image', extensions: ['png','jpg','jpeg','webp','bmp','tiff','heic','avif','ico','svg'] },
      { name: 'Document', extensions: ['pdf','docx','txt','rtf','md','html','csv','json','xml'] },
    ],
  });
  return result.filePaths || [];
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose Output Folder',
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('open-image-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: 'Choose Cover Image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'heic', 'avif'] }],
  });
  return result.filePaths[0] || null;
});

ipcMain.handle('check-ffmpeg', () => {
  const p = getFfmpegPath();
  return new Promise(resolve => {
    const proc = spawn(p, ['-version']);
    proc.on('close', code => resolve({ found: code === 0, path: p }));
    proc.on('error', () => resolve({ found: false, path: p }));
  });
});

// ── Settings (stored as JSON in userData) ──────────────────────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const raw = fs.readFileSync(getSettingsPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettings(data) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {}
}

ipcMain.handle('get-settings', () => readSettings());

ipcMain.handle('save-settings', (_, data) => {
  writeSettings(data);
  return true;
});
