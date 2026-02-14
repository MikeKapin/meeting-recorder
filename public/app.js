/* ========================================================
   Meeting Recorder PWA — app.js
   Reliability-first audio recording with Whisper transcription
   ======================================================== */

(function () {
  'use strict';

  // ── IndexedDB ──────────────────────────────────────────
  const DB_NAME = 'MeetingRecorderDB';
  const DB_VERSION = 1;
  const STORE_RECORDINGS = 'recordings';
  const STORE_CHUNKS = 'chunks';

  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_RECORDINGS)) {
          d.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(STORE_CHUNKS)) {
          const cs = d.createObjectStore(STORE_CHUNKS, { keyPath: 'id', autoIncrement: true });
          cs.createIndex('recordingId', 'recordingId', { unique: false });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbPut(store, data) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  function dbGet(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbGetAll(store) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  function dbGetChunks(recordingId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readonly');
      const idx = tx.objectStore(STORE_CHUNKS).index('recordingId');
      const req = idx.getAll(recordingId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  function dbDeleteChunks(recordingId) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CHUNKS, 'readwrite');
      const store = tx.objectStore(STORE_CHUNKS);
      const idx = store.index('recordingId');
      const req = idx.openCursor(IDBKeyRange.only(recordingId));
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = e => reject(e.target.error);
    });
  }

  // ── State ──────────────────────────────────────────────
  let mediaRecorder = null;
  let audioStream = null;
  let analyserNode = null;
  let audioContext = null;
  let recordingId = null;
  let recordingStartTime = null;
  let pausedDuration = 0;
  let pauseStart = null;
  let timerInterval = null;
  let chunkInterval = null;
  let wakeLock = null;
  let currentRecording = null; // for result view
  let levelAnimFrame = null;

  // ── DOM refs ───────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const viewRecord = $('view-record');
  const viewResult = $('view-result');
  const viewArchive = $('view-archive');
  const btnRecord = $('btn-record');
  const btnPause = $('btn-pause');
  const btnStop = $('btn-stop');
  const recIndicator = $('rec-indicator');
  const recTimer = $('rec-timer');
  const recControls = $('rec-controls');
  const recHint = $('rec-hint');
  const recStatus = $('rec-status');
  const audioLevelContainer = $('audio-level-container');
  const audioLevelCanvas = $('audio-level');
  const batteryWarning = $('battery-warning');
  const storageWarning = $('storage-warning');
  const offlineBadge = $('offline-badge');
  const recoveryBanner = $('recovery-banner');
  const btnRecover = $('btn-recover');
  const btnDiscardRecovery = $('btn-discard-recovery');
  const btnStealth = $('btn-stealth');
  const stealthOverlay = $('stealth-overlay');
  const stealthTimer = $('stealth-timer');

  // ── Helpers ────────────────────────────────────────────
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${ss}`;
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function generateId() {
    return 'rec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  function filenameFromDate(ts) {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `meeting-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ── Navigation ─────────────────────────────────────────
  const views = { record: viewRecord, archive: viewArchive };
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.view;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      [viewRecord, viewResult, viewArchive].forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
      const v = views[target];
      if (v) { v.classList.remove('hidden'); v.classList.add('active'); }
      if (target === 'archive') loadArchive();
    });
  });

  function showView(name) {
    [viewRecord, viewResult, viewArchive].forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
    const v = name === 'record' ? viewRecord : name === 'result' ? viewResult : viewArchive;
    v.classList.remove('hidden');
    v.classList.add('active');
  }

  // ── Battery & Storage Monitoring ──────────────────────
  async function checkBattery() {
    try {
      if ('getBattery' in navigator) {
        const batt = await navigator.getBattery();
        const update = () => {
          batteryWarning.classList.toggle('hidden', batt.level > 0.15 || batt.charging);
        };
        batt.addEventListener('levelchange', update);
        batt.addEventListener('chargingchange', update);
        update();
      }
    } catch (e) { /* not supported */ }
  }

  async function checkStorage() {
    try {
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const est = await navigator.storage.estimate();
        const usedPct = est.usage / est.quota;
        storageWarning.classList.toggle('hidden', usedPct < 0.9);
      }
    } catch (e) { /* not supported */ }
  }

  // ── Online/Offline ────────────────────────────────────
  function updateOnline() {
    offlineBadge.classList.toggle('hidden', navigator.onLine);
  }
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);

  // ── Wake Lock (keep screen/recording alive) ────────────
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { /* user denied or not supported */ }
  }

  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
  }

  // Re-acquire wake lock when page becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && mediaRecorder && mediaRecorder.state !== 'inactive') {
      requestWakeLock();
    }
  });

  // ── Audio Level Visualization ──────────────────────────
  function startLevelMeter(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    source.connect(analyserNode);

    const bufLen = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufLen);
    const ctx = audioLevelCanvas.getContext('2d');
    const W = audioLevelCanvas.width;
    const H = audioLevelCanvas.height;

    function draw() {
      levelAnimFrame = requestAnimationFrame(draw);
      analyserNode.getByteFrequencyData(dataArray);
      ctx.fillStyle = '#16213e';
      ctx.fillRect(0, 0, W, H);

      const barW = (W / bufLen) * 2.5;
      let x = 0;
      for (let i = 0; i < bufLen; i++) {
        const v = dataArray[i] / 255;
        const barH = v * H;
        const r = 233 + (v * 20);
        const g = 69 - (v * 40);
        const b = 96;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, H - barH, barW - 1, barH);
        x += barW;
        if (x > W) break;
      }
    }
    draw();
  }

  function stopLevelMeter() {
    if (levelAnimFrame) cancelAnimationFrame(levelAnimFrame);
    if (audioContext) { audioContext.close(); audioContext = null; }
    analyserNode = null;
  }

  // ── Recording ──────────────────────────────────────────
  async function startRecording() {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000
        }
      });
    } catch (e) {
      recStatus.textContent = '❌ Microphone access denied';
      return;
    }

    recordingId = generateId();
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : 'audio/mp4';

    // Save recording metadata immediately
    await dbPut(STORE_RECORDINGS, {
      id: recordingId,
      startTime: Date.now(),
      endTime: null,
      duration: null,
      mimeType: mimeType,
      status: 'recording',
      transcript: null,
      segments: null,
      blob: null
    });

    mediaRecorder = new MediaRecorder(audioStream, { mimeType });
    const allChunks = [];

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0) {
        allChunks.push(e.data);
        // Save chunk to IndexedDB for crash safety
        try {
          await dbPut(STORE_CHUNKS, {
            recordingId: recordingId,
            timestamp: Date.now(),
            data: e.data
          });
          recStatus.textContent = `✓ Saved (${allChunks.length} chunks)`;
        } catch (err) {
          recStatus.textContent = '⚠️ Chunk save failed - still recording';
        }
      }
    };

    mediaRecorder.onstop = async () => {
      const endTime = Date.now();
      const duration = endTime - recordingStartTime - pausedDuration;

      // Assemble final blob from all chunks
      const chunks = await dbGetChunks(recordingId);
      const blobParts = chunks.map(c => c.data);
      const finalBlob = new Blob(blobParts, { type: mimeType });

      // Save complete recording
      await dbPut(STORE_RECORDINGS, {
        id: recordingId,
        startTime: recordingStartTime,
        endTime: endTime,
        duration: duration,
        mimeType: mimeType,
        status: 'recorded',
        transcript: null,
        segments: null,
        blob: finalBlob
      });

      // Clean up chunks (we have the final blob now)
      await dbDeleteChunks(recordingId);

      // Stop everything
      clearInterval(timerInterval);
      clearInterval(chunkInterval);
      stopLevelMeter();
      releaseWakeLock();
      audioStream.getTracks().forEach(t => t.stop());

      // Show result
      currentRecording = await dbGet(STORE_RECORDINGS, recordingId);
      showResultView(currentRecording);

      // Reset state
      mediaRecorder = null;
      audioStream = null;
      recordingId = null;
      pausedDuration = 0;
      pauseStart = null;
      resetRecordUI();
    };

    // Request timeslice every 30s for auto-save chunks
    mediaRecorder.start(30000);
    recordingStartTime = Date.now();
    pausedDuration = 0;

    // UI
    btnRecord.classList.add('recording');
    btnRecord.querySelector('svg circle').setAttribute('rx', '8');
    btnRecord.querySelector('svg circle').setAttribute('ry', '8');
    recIndicator.classList.remove('hidden');
    audioLevelContainer.classList.remove('hidden');
    recControls.classList.remove('hidden');
    btnStealth.classList.remove('hidden');
    recHint.classList.add('hidden');
    recStatus.textContent = 'Recording...';

    // Timer
    timerInterval = setInterval(() => {
      const elapsed = Date.now() - recordingStartTime - pausedDuration - (pauseStart ? Date.now() - pauseStart : 0);
      recTimer.textContent = fmtTime(elapsed);
    }, 200);

    // Level meter
    startLevelMeter(audioStream);

    // Wake lock
    await requestWakeLock();

    // Check storage periodically
    chunkInterval = setInterval(checkStorage, 60000);
  }

  function pauseRecording() {
    if (!mediaRecorder) return;
    if (mediaRecorder.state === 'recording') {
      mediaRecorder.pause();
      pauseStart = Date.now();
      btnPause.textContent = '▶ Resume';
      recStatus.textContent = 'Paused';
      document.querySelector('.red-dot').style.animationPlayState = 'paused';
    } else if (mediaRecorder.state === 'paused') {
      mediaRecorder.resume();
      pausedDuration += Date.now() - pauseStart;
      pauseStart = null;
      btnPause.textContent = '⏸ Pause';
      recStatus.textContent = 'Recording...';
      document.querySelector('.red-dot').style.animationPlayState = 'running';
    }
  }

  function stopRecording() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    if (pauseStart) {
      pausedDuration += Date.now() - pauseStart;
      pauseStart = null;
    }
    // Request final data then stop
    mediaRecorder.requestData();
    setTimeout(() => mediaRecorder.stop(), 100);
  }

  function resetRecordUI() {
    btnRecord.classList.remove('recording');
    const circle = btnRecord.querySelector('svg circle');
    circle.removeAttribute('rx');
    circle.removeAttribute('ry');
    recIndicator.classList.add('hidden');
    audioLevelContainer.classList.add('hidden');
    recControls.classList.add('hidden');
    btnStealth.classList.add('hidden');
    recHint.classList.remove('hidden');
    recHint.textContent = 'Tap to record';
    recStatus.textContent = '';
    recTimer.textContent = '00:00:00';
    btnPause.textContent = '⏸ Pause';
    document.querySelector('.red-dot').style.animationPlayState = 'running';
    if (stealthMode) disableStealthMode();
  }

  // Record button handler
  btnRecord.addEventListener('click', () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      startRecording();
    } else {
      stopRecording();
    }
  });
  btnStop.addEventListener('click', stopRecording);
  btnPause.addEventListener('click', pauseRecording);

  // ── Stealth Mode ───────────────────────────────────────
  let stealthMode = false;

  function enableStealthMode() {
    stealthMode = true;
    stealthOverlay.classList.remove('hidden');
    // Dim screen brightness if supported
    if ('screen' in window && 'orientation' in window.screen) {
      document.body.style.filter = 'brightness(0.1)';
    }
  }

  function disableStealthMode() {
    stealthMode = false;
    stealthOverlay.classList.add('hidden');
    document.body.style.filter = '';
  }

  btnStealth.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      enableStealthMode();
    }
  });

  stealthOverlay.addEventListener('click', disableStealthMode);

  // Update stealth timer
  function updateStealthTimer() {
    if (stealthMode && recordingStartTime) {
      const elapsed = Date.now() - recordingStartTime - pausedDuration;
      stealthTimer.textContent = fmtTime(elapsed);
    }
  }

  // Add to existing timer interval
  const originalTimerInterval = timerInterval;
  setInterval(() => {
    if (stealthMode) {
      updateStealthTimer();
    }
  }, 1000);

  // ── Result View ────────────────────────────────────────
  function showResultView(rec) {
    showView('result');
    const fname = filenameFromDate(rec.startTime);
    $('result-title').textContent = fname;
    $('result-meta').textContent = `${fmtDate(rec.startTime)} · ${fmtTime(rec.duration)}`;

    // Reset transcription UI
    $('transcription-progress').classList.add('hidden');
    $('transcript-result').classList.add('hidden');
    $('progress-fill').style.width = '0%';

    if (rec.transcript) {
      showTranscript(rec);
    }
  }

  // Download audio
  $('btn-download-audio').addEventListener('click', () => {
    if (!currentRecording || !currentRecording.blob) return;
    const ext = currentRecording.mimeType.includes('webm') ? 'webm' : 'mp4';
    const fname = filenameFromDate(currentRecording.startTime) + '.' + ext;
    downloadBlob(currentRecording.blob, fname);
  });

  // Back to record
  $('btn-back-record').addEventListener('click', () => {
    showView('record');
    currentRecording = null;
  });

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    downloadBlob(blob, filename);
  }

  // ── Transcription ─────────────────────────────────────
  $('btn-transcribe').addEventListener('click', () => transcribe(currentRecording));

  async function transcribe(rec) {
    if (!rec || !rec.blob) return;

    const progressContainer = $('transcription-progress');
    const progressFill = $('progress-fill');
    const progressText = $('progress-text');
    progressContainer.classList.remove('hidden');
    progressFill.style.width = '10%';
    progressText.textContent = 'Uploading audio...';

    try {
      // Convert blob to base64
      const base64 = await blobToBase64(rec.blob);
      progressFill.style.width = '30%';
      progressText.textContent = 'Starting transcription...';

      // Send to Netlify function
      const resp = await fetch('/.netlify/functions/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audio: base64,
          mimeType: rec.mimeType
        })
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(err || 'Upload failed');
      }

      const { predictionId } = await resp.json();
      progressFill.style.width = '40%';
      progressText.textContent = 'Transcribing (this may take a few minutes)...';

      // Poll for completion
      const result = await pollTranscription(predictionId, progressFill, progressText);

      // Save transcript
      rec.transcript = result.text || result.transcription || '';
      rec.segments = result.segments || [];
      rec.status = 'transcribed';
      await dbPut(STORE_RECORDINGS, rec);
      currentRecording = rec;

      progressFill.style.width = '100%';
      progressText.textContent = 'Done!';
      showTranscript(rec);

    } catch (e) {
      progressFill.style.width = '0%';
      progressText.textContent = '❌ ' + e.message + ' — Your audio is safe. Try again.';
      console.error('Transcription error:', e);
    }
  }

  async function pollTranscription(predictionId, fillEl, textEl) {
    const maxAttempts = 180; // 15 minutes at 5s intervals
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(5000);
      const pct = 40 + Math.min(55, (i / maxAttempts) * 55);
      fillEl.style.width = pct + '%';

      const resp = await fetch(`/.netlify/functions/transcribe?id=${predictionId}`);
      if (!resp.ok) {
        textEl.textContent = 'Checking status...';
        continue;
      }
      const data = await resp.json();

      if (data.status === 'succeeded') {
        return data.output;
      } else if (data.status === 'failed' || data.status === 'canceled') {
        throw new Error('Transcription ' + data.status + ': ' + (data.error || ''));
      }
      textEl.textContent = `Transcribing... (${Math.round(pct)}%)`;
    }
    throw new Error('Transcription timed out');
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Show Transcript ────────────────────────────────────
  function showTranscript(rec) {
    const container = $('transcript-result');
    const textEl = $('transcript-text');
    container.classList.remove('hidden');

    if (rec.segments && rec.segments.length > 0) {
      textEl.innerHTML = rec.segments.map(s => {
        const startTime = fmtTimeSec(s.start);
        return `<span class="seg-time">[${startTime}]</span> ${escapeHtml(s.text)}`;
      }).join('\n');
    } else {
      textEl.textContent = rec.transcript || 'No transcript available';
    }

    // Wire download buttons
    const fname = filenameFromDate(rec.startTime);

    $('btn-dl-txt').onclick = () => {
      let txt = rec.segments && rec.segments.length > 0
        ? rec.segments.map(s => `[${fmtTimeSec(s.start)}] ${s.text}`).join('\n')
        : rec.transcript;
      downloadText(txt, fname + '.txt');
    };

    $('btn-dl-md').onclick = () => {
      const ext = rec.mimeType.includes('webm') ? 'webm' : 'mp4';
      let md = `---\ntitle: Meeting Recording\ndate: ${new Date(rec.startTime).toISOString()}\nduration: ${fmtTime(rec.duration)}\naudio_file: ${fname}.${ext}\n---\n\n# Meeting Transcript\n\n`;
      if (rec.segments && rec.segments.length > 0) {
        md += rec.segments.map(s => `**[${fmtTimeSec(s.start)}]** ${s.text}`).join('\n\n');
      } else {
        md += rec.transcript;
      }
      downloadText(md, fname + '.md');
    };

    $('btn-dl-json').onclick = () => {
      const ext = rec.mimeType.includes('webm') ? 'webm' : 'mp4';
      const json = {
        type: 'meeting_transcript',
        date: new Date(rec.startTime).toISOString(),
        duration: fmtTime(rec.duration),
        audio_file: fname + '.' + ext,
        transcript: rec.transcript,
        segments: (rec.segments || []).map(s => ({
          start: s.start,
          end: s.end,
          text: s.text
        }))
      };
      downloadText(JSON.stringify(json, null, 2), fname + '.json', 'application/json');
    };

    // Generate Summary button
    $('btn-summarize').onclick = async () => {
      await generateSummary(rec);
    };
  }

  // ── Summarize ──────────────────────────────────────────
  async function generateSummary(rec) {
    const summaryProgress = $('summary-progress');
    const summaryResult = $('summary-result');
    const summaryText = $('summary-text');
    const summaryProgressFill = $('summary-progress-fill');
    const summaryProgressText = $('summary-progress-text');

    // Show progress
    summaryProgress.classList.remove('hidden');
    summaryResult.classList.add('hidden');
    summaryProgressFill.style.width = '10%';
    summaryProgressText.textContent = 'Sending transcript to Claude...';

    try {
      const response = await fetch('/.netlify/functions/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: rec.transcript })
      });

      summaryProgressFill.style.width = '50%';
      summaryProgressText.textContent = 'Analyzing transcript...';

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to generate summary');
      }

      const data = await response.json();

      summaryProgressFill.style.width = '100%';
      summaryProgressText.textContent = 'Complete!';

      // Save summary to recording
      rec.summary = data.summary;
      await dbPut(STORE_RECORDINGS, rec);

      // Display summary
      summaryText.innerHTML = marked(data.summary);

      setTimeout(() => {
        summaryProgress.classList.add('hidden');
        summaryResult.classList.remove('hidden');
      }, 500);

      // Setup download/copy buttons
      $('btn-copy-summary').onclick = () => {
        navigator.clipboard.writeText(data.summary);
        $('btn-copy-summary').textContent = '✓ Copied!';
        setTimeout(() => {
          $('btn-copy-summary').textContent = '📋 Copy Summary';
        }, 2000);
      };

      $('btn-dl-summary').onclick = () => {
        const fname = filenameFromDate(rec.startTime);
        downloadText(data.summary, fname + '-summary.md');
      };

    } catch (e) {
      summaryProgressText.textContent = '❌ Error: ' + e.message;
      setTimeout(() => {
        summaryProgress.classList.add('hidden');
      }, 3000);
    }
  }

  // Simple markdown renderer
  function marked(text) {
    return text
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^- (.*$)/gim, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(.+)$/gim, '<p>$1</p>')
      .replace(/<p><\/p>/g, '')
      .replace(/<p>(<h[123]>)/g, '$1')
      .replace(/(<\/h[123]>)<\/p>/g, '$1')
      .replace(/<p>(<ul>)/g, '$1')
      .replace(/(<\/ul>)<\/p>/g, '$1');
  }

  function fmtTimeSec(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Archive ────────────────────────────────────────────
  async function loadArchive() {
    const list = $('archive-list');
    const empty = $('archive-empty');
    list.innerHTML = '';

    const recs = await dbGetAll(STORE_RECORDINGS);
    recs.sort((a, b) => b.startTime - a.startTime);

    // Filter out in-progress recordings
    const completed = recs.filter(r => r.status !== 'recording');

    if (completed.length === 0) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    completed.forEach(rec => {
      const item = document.createElement('div');
      item.className = 'archive-item';
      const statusClass = rec.status === 'transcribed' ? 'status-transcribed' : 'status-recorded';
      const statusLabel = rec.status === 'transcribed' ? '✓ Transcribed' : '● Recorded';
      const ext = rec.mimeType && rec.mimeType.includes('webm') ? 'webm' : 'mp4';

      item.innerHTML = `
        <div class="archive-item-header">
          <span class="archive-item-date">${fmtDate(rec.startTime)}</span>
          <span class="archive-item-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="archive-item-duration">${fmtTime(rec.duration || 0)}</div>
        <div class="archive-item-actions">
          <button data-action="audio" data-id="${rec.id}">⬇ Audio</button>
          ${rec.status === 'transcribed'
            ? `<button data-action="view" data-id="${rec.id}">📄 View</button>`
            : `<button data-action="transcribe" data-id="${rec.id}">🎤 Transcribe</button>`
          }
          <button data-action="delete" data-id="${rec.id}" class="delete-btn">🗑</button>
        </div>
      `;
      list.appendChild(item);
    });

    // Event delegation
    list.onclick = async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const rec = await dbGet(STORE_RECORDINGS, id);
      if (!rec) return;

      if (action === 'audio' && rec.blob) {
        const ext = rec.mimeType && rec.mimeType.includes('webm') ? 'webm' : 'mp4';
        downloadBlob(rec.blob, filenameFromDate(rec.startTime) + '.' + ext);
      } else if (action === 'view' || action === 'transcribe') {
        currentRecording = rec;
        showView('result');
        showResultView(rec);
        if (action === 'transcribe') transcribe(rec);
      } else if (action === 'delete') {
        if (confirm('Delete this recording permanently?')) {
          await dbDelete(STORE_RECORDINGS, id);
          await dbDeleteChunks(id);
          loadArchive();
        }
      }
    };
  }

  // ── Crash Recovery ────────────────────────────────────
  async function checkRecovery() {
    const recs = await dbGetAll(STORE_RECORDINGS);
    const inProgress = recs.filter(r => r.status === 'recording');

    if (inProgress.length === 0) return;

    recoveryBanner.classList.remove('hidden');

    btnRecover.onclick = async () => {
      for (const rec of inProgress) {
        const chunks = await dbGetChunks(rec.id);
        if (chunks.length > 0) {
          const blobParts = chunks.map(c => c.data);
          const finalBlob = new Blob(blobParts, { type: rec.mimeType });
          const duration = chunks[chunks.length - 1].timestamp - rec.startTime;

          await dbPut(STORE_RECORDINGS, {
            ...rec,
            endTime: chunks[chunks.length - 1].timestamp,
            duration: duration,
            status: 'recorded',
            blob: finalBlob
          });
          await dbDeleteChunks(rec.id);
        } else {
          await dbDelete(STORE_RECORDINGS, rec.id);
        }
      }
      recoveryBanner.classList.add('hidden');
      recStatus.textContent = '✓ Recording recovered!';
    };

    btnDiscardRecovery.onclick = async () => {
      for (const rec of inProgress) {
        await dbDelete(STORE_RECORDINGS, rec.id);
        await dbDeleteChunks(rec.id);
      }
      recoveryBanner.classList.add('hidden');
    };
  }

  // ── Service Worker Registration ────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e =>
      console.warn('SW registration failed:', e)
    );
  }

  // ── Init ───────────────────────────────────────────────
  async function init() {
    await openDB();
    checkBattery();
    checkStorage();
    updateOnline();
    checkRecovery();
  }

  init();
})();
