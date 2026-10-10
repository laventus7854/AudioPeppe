/* ==========================================================================
   app.js — UI-логика приложения
   Зависит от audio-engine.js и tests.js
   ========================================================================== */

(function () {
  'use strict';

  const E = window.AudioEngine;
  const T = window.AudioTests;
  const { dbToGain, gainToDb } = window.AudioEngineUtils;

  /* ------------------------------------------------------------------ */
  /* DOM refs                                                           */
  /* ------------------------------------------------------------------ */
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    html: document.documentElement,
    main: $('#main'),
    ctxStatus:  $('#ctx-status'),
    ctxRate:    $('#ctx-rate'),
    ctxLatency: $('#ctx-latency'),
    ctxBt:      $('#ctx-bt'),
    btnStart:   $('#btn-start-audio'),
    btnTheme:   $('#btn-theme'),
    btnStop:    $('#btn-emergency-stop'),
    btnRefresh: $('#btn-refresh-devices'),
    btnMic:     $('#btn-request-mic'),
    micStatus:  $('#mic-status'),
    selOut:     $('#select-output'),
    selIn:      $('#select-input'),
    // frequency generator
    genFreq:    $('#gen-freq'),
    genFreqNum: $('#gen-freq-num'),
    genFreqVal: $('#gen-freq-val'),
    genVol:     $('#gen-vol'),
    genVolVal:  $('#gen-vol-val'),
    genWave:    $('#gen-wave'),
    genChan:    $('#gen-channel'),
    // sweeps
    sweepFullBar:  $('#sweep-full-bar'),
    sweepFullFreq: $('#sweep-full-freq'),
    sweepBassFreq: $('#sweep-bass-freq'),
    sweepSubFreq:  $('#sweep-sub-freq'),
    // VU / SPL
    vuFill:   $('#vu-fill'),
    vuDb:     $('#vu-db'),
    vuClip:   $('#vu-clip'),
    // canvases
    canvasFFT: $('#canvas-fft'),
    canvasFR:  $('#canvas-fr'),
    // reports
    resReport: $('#res-report'),
    historyList: $('#history-list'),
    // noise
    noiseType: $('#noise-type'),
    // suppression checkboxes
    chkEcho:  $('#chk-echo'),
    chkNoise: $('#chk-noise'),
    chkAgc:   $('#chk-agc')
  };

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */
  const state = {
    inputDeviceId: null,
    outputDeviceId: null,
    lastRecorded: null,
    lastHearingFreq: null,
    section: 'dashboard',
    timers: new Set(),
    bluetooth: false
  };

  /* ------------------------------------------------------------------ */
  /* Toast / уведомления                                                */
  /* ------------------------------------------------------------------ */
  function toast(msg, type = 'info', ttl = 3200) {
    const div = document.createElement('div');
    div.textContent = msg;
    div.style.cssText = `
      position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
      background:${type === 'error' ? '#ef4444' : type === 'warn' ? '#fbbf24' : '#1f2937'};
      color:${type === 'warn' ? '#000' : '#fff'};
      padding:10px 16px;border-radius:10px;font-size:13px;z-index:9999;
      box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:90vw;text-align:center;
      transition:opacity .3s ease;
    `;
    document.body.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; }, ttl - 300);
    setTimeout(() => div.remove(), ttl);
  }

  /* ------------------------------------------------------------------ */
  /* Theme                                                              */
  /* ------------------------------------------------------------------ */
  function applyTheme(theme) {
    el.html.setAttribute('data-theme', theme);
    try { localStorage.setItem('audio-diag-theme', theme); } catch (_) {}
  }
  function initTheme() {
    let t;
    try { t = localStorage.getItem('audio-diag-theme'); } catch (_) {}
    if (!t) t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    applyTheme(t);
  }
  el.btnTheme.addEventListener('click', () => {
    applyTheme(el.html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  /* ------------------------------------------------------------------ */
  /* Router (hash)                                                      */
  /* ------------------------------------------------------------------ */
  function navigate(sectionId) {
    const target = document.getElementById(sectionId);
    if (!target) return;
    $$('.panel').forEach((p) => p.classList.toggle('active', p === target));
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.section === sectionId));
    state.section = sectionId;
    if (location.hash !== '#' + sectionId) {
      history.replaceState(null, '', '#' + sectionId);
    }
    // Ресайз канвасов при переходе на раздел
    requestAnimationFrame(() => resizeAllCanvases());
  }
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (h && h !== state.section) navigate(h);
  });

  /* ------------------------------------------------------------------ */
  /* Device enumeration                                                 */
  /* ------------------------------------------------------------------ */
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      el.selOut.innerHTML = '<option>(не поддерживается)</option>';
      el.selIn.innerHTML  = '<option>(не поддерживается)</option>';
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    const ins  = devices.filter((d) => d.kind === 'audioinput');

    const fill = (sel, list, defaultLabel) => {
      sel.innerHTML = '';
      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = defaultLabel;
        opt.value = '';
        sel.appendChild(opt);
        return;
      }
      list.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${defaultLabel} ${i + 1}${d.deviceId === 'default' ? ' (по умолчанию)' : ''}`;
        sel.appendChild(opt);
      });
      // восстановить выбор
      if (sel === el.selIn && state.inputDeviceId) {
        sel.value = state.inputDeviceId;
      }
      if (sel === el.selOut && state.outputDeviceId) {
        sel.value = state.outputDeviceId;
      }
    };
    fill(el.selOut, outs, 'Устройство вывода');
    fill(el.selIn,  ins,  'Устройство ввода');

    // Определить bluetooth по строке
    const selectedLabel = (el.selOut.selectedOptions[0]?.textContent || '').toLowerCase();
    state.bluetooth = /bluetooth|bt|airpod|buds|wh-|wf-|jbl|sennheiser/.test(selectedLabel);
    el.ctxBt.textContent = state.bluetooth ? 'Возможно, Bluetooth' : 'Проводное (?)';
  }

  el.btnRefresh.addEventListener('click', refreshDevices);

  el.selOut.addEventListener('change', async () => {
    state.outputDeviceId = el.selOut.value;
    if (!E.ctx) { toast('Сначала запустите аудио-движок', 'warn'); return; }
    if (typeof E.ctx.setSinkId === 'function') {
      try {
        await E.ctx.setSinkId(state.outputDeviceId);
        toast('Устройство вывода переключено');
      } catch (err) {
        toast('Не удалось переключить вывод: ' + err.message, 'error');
      }
    } else {
      toast('Браузер не поддерживает смену вывода на лету. Перезапустите движок.', 'warn');
    }
    refreshDevices();
  });

  el.selIn.addEventListener('change', async () => {
    state.inputDeviceId = el.selIn.value;
    if (!state.inputDeviceId) return;
    if (!E.ctx) { toast('Сначала запустите аудио-движок', 'warn'); return; }
    try {
      await switchMicDevice(state.inputDeviceId);
      toast('Микрофон переключён');
    } catch (err) {
      toast('Ошибка доступа к микрофону: ' + err.message, 'error');
    }
  });

  /* Хак: перезапуск mic с конкретным deviceId */
  async function switchMicDevice(deviceId) {
    await E.stopMic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: E.micConstraints.echoCancellation,
        noiseSuppression: E.micConstraints.noiseSuppression,
        autoGainControl:   E.micConstraints.autoGainControl
      },
      video: false
    });
    await E.whenReady();
    E.micStream = stream;
    E.micSource = E.ctx.createMediaStreamSource(stream);
    E.micAnalyser = E.ctx.createAnalyser();
    E.micAnalyser.fftSize = 4096;
    E.micAnalyser.smoothingTimeConstant = 0.6;
    E.micGain = E.ctx.createGain();
    E.micGain.gain.value = 1.0;
    E.micSource.connect(E.micGain);
    E.micGain.connect(E.micAnalyser);
    el.micStatus.textContent = 'Микрофон: активен (' + (stream.getAudioTracks()[0]?.label || 'default') + ')';
  }

  /* ------------------------------------------------------------------ */
  /* Audio engine init                                                  */
  /* ------------------------------------------------------------------ */
  el.btnStart.addEventListener('click', async () => {
    try {
      await E.init();
      updateCtxInfo();
      toast('Аудио-движок запущен');
    } catch (err) {
      toast('Не удалось запустить аудио: ' + err.message, 'error');
    }
  });

  function updateCtxInfo() {
    const info = E.info();
    if (!info) return;
    el.ctxStatus.textContent = info.state;
    el.ctxRate.textContent = info.sampleRate + ' Гц';
    el.ctxLatency.textContent =
      (info.outputLatency ? (info.outputLatency * 1000).toFixed(1) : '—') + ' мс';
  }

  el.btnMic.addEventListener('click', async () => {
    try {
      await E.init();
      await E.startMic();
      el.micStatus.textContent = 'Микрофон: активен';
      toast('Доступ к микрофону получен');
      await refreshDevices();
    } catch (err) {
      el.micStatus.textContent = 'Микрофон: отклонён';
      toast('Не удалось получить доступ: ' + err.message, 'error');
    }
  });

  /* ------------------------------------------------------------------ */
  /* Emergency STOP                                                     */
  /* ------------------------------------------------------------------ */
  el.btnStop.addEventListener('click', () => {
    // Остановить все активные узлы
    E.stopAll();
    // Остановить сервисные таймеры
    T.stopPingPong();
    T.stopManualTone();
    T.stopLoudTest();
    T.stopNoise();
    T.stopVU();
    T.stopSpectrum();
    T.stopSPL();
    state.timers.forEach((id) => clearInterval(id));
    state.timers.clear();
    toast('Все сигналы остановлены');
  });

  /* ------------------------------------------------------------------ */
  /* Delegated event handler                                            */
  /* ------------------------------------------------------------------ */
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-test], [data-jump], [data-hf], [data-surround], [data-xover], [data-hearing], [data-dtmf]');
    if (!btn) return;

    // ── Быстрый переход
    if (btn.dataset.jump) {
      navigate(btn.dataset.jump);
      return;
    }

    // ── HF чип
    if (btn.dataset.hf) {
      safe(() => T.playHighTone(parseInt(btn.dataset.hf, 10)));
      return;
    }

    // ── Surround
    if (btn.dataset.surround) {
      safe(() => T.testSurround(btn.dataset.surround));
      return;
    }

    // ── Xover
    if (btn.dataset.xover) {
      safe(() => T.testCrossover(parseInt(btn.dataset.xover, 10)));
      return;
    }

    // ── DTMF
    if (btn.dataset.dtmf) {
      safe(() => T.playDTMF(btn.dataset.dtmf));
      return;
    }

    // ── Hearing
    if (btn.dataset.hearing) {
      const f = parseInt(btn.dataset.hearing, 10);
      await safeAsync(() => T.playHearingTone(f));
      showHearingMark(f);
      return;
    }

    // ── data-test
    const key = btn.dataset.test;
    if (!key) return;
    await handleTest(key);
  });

  async function handleTest(key) {
    switch (key) {
      // ---------- CHANNELS ----------
      case 'ch-left':   await safeAsync(() => T.testChannel('left')); break;
      case 'ch-right':  await safeAsync(() => T.testChannel('right')); break;
      case 'ch-both':   await safeAsync(() => T.testChannel('both')); break;

      case 'balance-cycle':
        await safeAsync(async () => {
          await T.testChannel('left');
          await new Promise((r) => setTimeout(r, 400));
          await T.testChannel('right');
          await new Promise((r) => setTimeout(r, 400));
          await T.testChannel('left');
          const div = $('#res-balance');
          div.className = 'result ok';
          div.textContent = 'Прозвучало L → R → L. Одинаковая ли громкость? Если один канал тише — есть дисбаланс.';
        });
        break;

      case 'pan-sweep':  await safeAsync(() => T.testPanSweep()); break;

      case 'crosstalk': {
        const dur = parseFloat($('#crosstalk-dur').value) || 3;
        await safeAsync(() => T.testCrosstalk(dur));
        break;
      }

      case 'pingpong-start': {
        const ms = parseFloat($('#pingpong-ms').value) || 500;
        T.startPingPong(ms);
        break;
      }
      case 'pingpong-stop': T.stopPingPong(); break;

      case 'bt-latency': await safeAsync(() => T.testBtLatency()); break;

      // ---------- FREQUENCY ----------
      case 'gen-start': {
        const freq = parseInt(el.genFreqNum.value || el.genFreq.value, 10);
        const type = el.genWave.value;
        const gainDb = parseFloat(el.genVol.value);
        const chan = el.genChan.value;
        await safeAsync(() => T.startManualTone({ freq, type, gainDb, channel: chan }));
        break;
      }
      case 'gen-stop': T.stopManualTone(); break;

      case 'sweep-full':
        T.sweepFull((f, p) => {
          el.sweepFullBar.style.width = (p * 100).toFixed(1) + '%';
          el.sweepFullFreq.textContent = Math.round(f) + ' Гц' + (f >= 1000 ? ' (' + (f / 1000).toFixed(2) + ' кГц)' : '');
        });
        break;

      case 'sweep-bass':
        T.sweepBass((f, p) => {
          el.sweepBassFreq.textContent = Math.round(f) + ' Гц';
        });
        break;

      case 'sweep-sub':
        T.sweepSub((f, p) => {
          el.sweepSubFreq.textContent = Math.round(f) + ' Гц';
        });
        break;

      case 'dead-zones':   await safeAsync(() => T.testDeadZones()); break;
      case 'resonances':   await safeAsync(() => T.testResonances()); break;

      // ---------- PHASE ----------
      case 'phase-in':   await safeAsync(() => T.testPhase(false)); break;
      case 'phase-out':  await safeAsync(() => T.testPhase(true)); break;
      case 'polarity-normal': await safeAsync(() => T.testPolarity(false)); break;
      case 'polarity-invert': await safeAsync(() => T.testPolarity(true)); break;
      case 'hp-phase':   await safeAsync(() => T.testHeadphonePhase()); break;

      // ---------- HEADPHONES ----------
      case 'hp-fr': {
        const curve = await safeAsync(() => T.testHeadphoneFR());
        if (curve) drawFRCurve(curve);
        break;
      }
      case 'hp-thd':     await safeAsync(() => T.testTHD()); break;
      case 'hp-crack':   await safeAsync(() => T.testCrackle()); break;
      case 'hp-loud':    await safeAsync(() => T.startLoudTest()); break;
      case 'hp-loud-mark-comfort': T.markLoud('comfort'); toast('Отмечен комфортный уровень'); break;
      case 'hp-loud-mark-pain':    T.markLoud('pain');    toast('Отмечен порог боли'); break;
      case 'hp-noise':   await safeAsync(() => T.testHeadphoneNoise()); break;

      // ---------- SPEAKERS ----------
      case 'scene':      await safeAsync(() => T.testScene()); break;

      // ---------- MICROPHONE ----------
      case 'mic-vu-start': await safeAsync(() => T.startVU()); break;
      case 'mic-vu-stop':  T.stopVU(); break;

      case 'mic-rec': {
        const rec = await safeAsync(() => T.testRecordAndPlay());
        if (rec) state.lastRecorded = rec;
        break;
      }
      case 'mic-play': {
        if (!state.lastRecorded) { toast('Сначала сделайте запись', 'warn'); break; }
        const src = E.ctx.createBufferSource();
        src.buffer = state.lastRecorded.buffer;
        src.connect(E.master);
        src.start();
        break;
      }
      case 'mic-download': T.downloadRecording(); break;

      case 'mic-restart-constraints':
        await safeAsync(() => T.restartMicConstraints({
          echoCancellation: el.chkEcho.checked,
          noiseSuppression: el.chkNoise.checked,
          autoGainControl:   el.chkAgc.checked
        }));
        break;

      case 'mic-rtt':   await safeAsync(() => T.testMicRTT()); break;
      case 'mic-echo':  await safeAsync(() => T.testEcho()); break;

      // ---------- MEASURE ----------
      case 'spectrum-start': await safeAsync(() => T.startSpectrum()); break;
      case 'spectrum-stop':  T.stopSpectrum(); break;
      case 'spl-start':      await safeAsync(() => T.startSPL()); break;
      case 'spl-cal':        await safeAsync(() => T.calibrateSPL()); break;
      case 'nfloor':         await safeAsync(() => T.testNoiseFloor()); break;
      case 'dyn-range':      await safeAsync(() => T.testDynRange()); break;
      case 'wow-flutter':    await safeAsync(() => T.testWowFlutter()); break;

      // ---------- TOOLS ----------
      case 'noise-start':  await safeAsync(() => T.startNoise(el.noiseType.value)); break;
      case 'noise-stop':   T.stopNoise(); break;
      case 'cal-start':    await safeAsync(() => T.calibrateSPL()); break;

      // ---------- REPORTS ----------
      case 'report-build':  buildAndShowReport(); break;
      case 'report-download': downloadCurrentReport(); break;
      case 'report-share': {
        const report = T.buildReport();
        const url = T.shareReport(report);
        try {
          await navigator.clipboard.writeText(url);
          toast('Ссылка скопирована в буфер обмена');
        } catch (_) {
          prompt('Скопируйте ссылку:', url);
        }
        break;
      }
      case 'hist-clear': T.clearHistory(); renderHistory(); break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Safe wrappers                                                      */
  /* ------------------------------------------------------------------ */
  async function safeAsync(fn) {
    try { return await fn(); }
    catch (err) {
      console.error(err);
      toast(err.message || 'Ошибка выполнения теста', 'error');
      return null;
    }
  }
  function safe(fn) {
    try { return fn(); }
    catch (err) { console.error(err); toast(err.message || 'Ошибка', 'error'); }
  }

  /* ------------------------------------------------------------------ */
  /* Frequency generator controls                                       */
  /* ------------------------------------------------------------------ */
  function syncGenFreq(v) {
    v = Math.min(20000, Math.max(20, v));
    el.genFreq.value = v;
    el.genFreqNum.value = v;
    el.genFreqVal.textContent = v;
    if (T.results) {} // no-op
    // Обновление live
    safe(() => T.updateManualTone({ freq: v }));
  }
  el.genFreq.addEventListener('input', () => syncGenFreq(parseInt(el.genFreq.value, 10)));
  el.genFreqNum.addEventListener('change', () => syncGenFreq(parseInt(el.genFreqNum.value, 10)));

  el.genVol.addEventListener('input', () => {
    el.genVolVal.textContent = el.genVol.value;
    safe(() => T.updateManualTone({ gainDb: parseFloat(el.genVol.value) }));
  });
  el.genWave.addEventListener('change', () => safe(() => T.updateManualTone({ type: el.genWave.value })));
  el.genChan.addEventListener('change', async () => {
    // Перезапустить с новым каналом
    const freq = parseInt(el.genFreqNum.value, 10);
    const type = el.genWave.value;
    const gainDb = parseFloat(el.genVol.value);
    const channel = el.genChan.value;
    T.stopManualTone();
    await safeAsync(() => T.startManualTone({ freq, type, gainDb, channel }));
  });

  /* ------------------------------------------------------------------ */
  /* Hearing test — динамическая кнопка "отметить"                      */
  /* ------------------------------------------------------------------ */
  function showHearingMark(freq) {
    const box = $('#res-hearing');
    box.innerHTML = '';
    const label = document.createElement('div');
    label.textContent = `Прозвучал тон ${(freq / 1000).toFixed(1)} кГц. `;
    const b = document.createElement('button');
    b.className = 'ghost-btn';
    b.textContent = '✓ Я слышу этот тон';
    b.addEventListener('click', () => {
      T.markHearingThreshold(freq);
      box.innerHTML = `<span class="ok">Отмечено: верхняя слышимая частота = ${(freq / 1000).toFixed(1)} кГц</span>`;
    });
    box.appendChild(label);
    box.appendChild(b);
  }

  /* ------------------------------------------------------------------ */
  /* Mic frame → VU и SPL                                               */
  /* ------------------------------------------------------------------ */
  window.addEventListener('mic:frame', (ev) => {
    const f = ev.detail;
    // VU
    const norm = Math.max(0, Math.min(1, (f.rmsDb + 60) / 60)); // -60..0 → 0..1
    el.vuFill.style.width = (norm * 100).toFixed(1) + '%';
    el.vuDb.textContent = f.rmsDb.toFixed(1) + ' дБ';
    const clipping = f.peakDb > -0.5;
    el.vuClip.classList.toggle('hidden', !clipping);
  });

  window.addEventListener('spl:frame', (ev) => {
    const { db, relDb } = ev.detail;
    const box = $('#res-spl');
    box.className = 'result';
    box.textContent =
      `Текущий уровень: ${db.toFixed(1)} дБFS` +
      (relDb != null ? `  |  Относительно калибровки: ${relDb.toFixed(1)} дБ` : '  |  Калибровка не задана');
  });

  /* ------------------------------------------------------------------ */
  /* Test result → запись в UI                                          */
  /* ------------------------------------------------------------------ */
  window.addEventListener('test:result', (ev) => {
    const { label, value, verdict, note, ts } = ev.detail;
    console.log('[test:result]', label, value, verdict);
    // Красим блок, если он соответствует разделу
    const map = {
      'Левый канал': '#res-channels',
      'Правый канал': '#res-channels',
      'Оба канала': '#res-channels',
      'Pan Sweep': '#res-pan',
      'Crosstalk (L→R)': '#res-crosstalk',
      'Round-trip latency': '#res-bt-latency',
      'Мёртвые зоны': '#res-dead-zones',
      'Резонансы': '#res-resonances',
      'In-Phase': '#res-phase',
      'Противофаза': '#res-phase',
      'THD @1 кГц': '#res-thd',
      'Комфорт громкости': '#res-loud',
      'Собственный шум': '#res-hp-noise',
      'Настройки подавления': '#res-suppression',
      'Round-trip': '#res-rtt',
      'Эхо/отражения': '#res-echo',
      'Noise floor': '#res-nfloor',
      'Динамический диапазон': '#res-dyn',
      'Wow & Flutter': '#res-wow',
      'Калибровка 0 дБ': '#res-cal',
      'Порог слышимости': '#res-hearing'
    };
    const target = map[label];
    if (target) {
      const box = $(target);
      if (box) {
        box.className = 'result ' + (verdict === 'ok' ? 'ok' : verdict === 'warn' ? 'warn' : verdict === 'bad' ? 'bad' : '');
        box.textContent = `${label}: ${value}` + (note ? '\n' + note : '');
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Canvas: FFT-спектр                                                 */
  /* ------------------------------------------------------------------ */
  function resizeCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(200, Math.floor(rect.width * dpr));
    const h = Math.max(100, Math.floor((canvas.dataset.h || canvas.height / dpr) * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  function resizeAllCanvases() {
    [el.canvasFFT, el.canvasFR].forEach((c) => c && resizeCanvas(c));
  }
  window.addEventListener('resize', resizeAllCanvases);

  let _spectrumActive = false;
  window.addEventListener('mic:spectrum', (ev) => {
    _spectrumActive = true;
    const { freq } = ev.detail;
    drawSpectrum(freq);
  });

  function drawSpectrum(freqData) {
    const c = el.canvasFFT;
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    // фон
    ctx.clearRect(0, 0, w, h);
    const bg = getComputedStyle(el.html).getPropertyValue('--bg-elev').trim();
    ctx.fillStyle = bg || '#111';
    ctx.fillRect(0, 0, w, h);

    const bars = 200;
    const step = Math.floor(freqData.length / bars);
    const barW = w / bars;
    const accent = getComputedStyle(el.html).getPropertyValue('--accent').trim() || '#4ea8ff';
    const accent2 = getComputedStyle(el.html).getPropertyValue('--accent-2').trim() || '#7c5cff';
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, accent);
    grad.addColorStop(1, accent2);

    ctx.fillStyle = grad;
    for (let i = 0; i < bars; i++) {
      let v = 0;
      for (let j = 0; j < step; j++) v = Math.max(v, freqData[i * step + j] || 0);
      const y = h - (v / 255) * h;
      ctx.fillRect(i * barW, y, barW - 1, h - y);
    }

    // подписи частот (логарифмическая шкала не точная, но полезно)
    ctx.fillStyle = getComputedStyle(el.html).getPropertyValue('--text-muted').trim() || '#888';
    ctx.font = (12 * (window.devicePixelRatio || 1)) + 'px sans-serif';
    const labels = [100, 1000, 5000, 10000, 20000];
    const sr = E.ctx ? E.ctx.sampleRate : 44100;
    labels.forEach((f) => {
      const bin = Math.round(f * freqData.length * 2 / sr);
      if (bin >= 0 && bin < freqData.length) {
        const x = (bin / freqData.length) * w;
        ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : f, x + 2, h - 4);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Canvas: FR-кривая                                                  */
  /* ------------------------------------------------------------------ */
  function drawFRCurve({ freqs, levels }) {
    const c = el.canvasFR;
    if (!c) return;
    const ctx = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    ctx.fillStyle = getComputedStyle(el.html).getPropertyValue('--bg-elev').trim() || '#111';
    ctx.fillRect(0, 0, w, h);

    if (!freqs.length) return;
    const minF = Math.log10(freqs[0]);
    const maxF = Math.log10(freqs[freqs.length - 1]);
    const minL = Math.min(...levels, -30);
    const maxL = 0;
    const xFor = (f) => ((Math.log10(f) - minF) / (maxF - minF)) * w;
    const yFor = (l) => h - ((l - minL) / (maxL - minL)) * h;

    // сетка
    ctx.strokeStyle = getComputedStyle(el.html).getPropertyValue('--border').trim() || '#333';
    ctx.lineWidth = 1;
    ctx.font = (11 * (window.devicePixelRatio || 1)) + 'px sans-serif';
    ctx.fillStyle = getComputedStyle(el.html).getPropertyValue('--text-muted').trim() || '#888';
    [100, 1000, 10000].forEach((f) => {
      const x = xFor(f);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : f, x + 2, h - 4);
    });
    [-30, -20, -10, 0].forEach((l) => {
      if (l < minL) return;
      const y = yFor(l);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(l + ' дБ', 4, y - 2);
    });

    // кривая
    ctx.strokeStyle = getComputedStyle(el.html).getPropertyValue('--accent').trim() || '#4ea8ff';
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    freqs.forEach((f, i) => {
      const x = xFor(f);
      const y = yFor(levels[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  /* ------------------------------------------------------------------ */
  /* Reports                                                            */
  /* ------------------------------------------------------------------ */
  function buildAndShowReport() {
    const report = T.buildReport();
    const score = report.score != null ? report.score : '—';
    const problems = report.problems || [];
    const recs = report.recommendations || [];

    let html = '';
    html += `<div><b>Оценка:</b> ${score} / 100</div>`;
    html += `<div><b>Всего тестов:</b> ${report.totalTests}</div>`;
    html += `<div><b>Дата:</b> ${new Date(report.ts).toLocaleString()}</div>`;
    html += `<div><b>Sample Rate:</b> ${report.info?.sampleRate || '—'} Гц</div>`;
    if (problems.length) {
      html += `<hr><b>Проблемы (${problems.length}):</b><ul>`;
      problems.forEach((p) => {
        html += `<li><b>${p.label}</b>: ${p.value} — <i>${p.note || ''}</i></li>`;
      });
      html += `</ul>`;
    } else {
      html += `<hr><span class="ok">Критических проблем не обнаружено.</span>`;
    }
    if (recs.length) {
      html += `<b>Рекомендации:</b><ul>`;
      recs.forEach((r) => html += `<li>${r}</li>`);
      html += `</ul>`;
    }
    el.resReport.innerHTML = html;
    el.resReport.classList.add('big');

    T.saveToHistory(report);
    renderHistory();
    toast('Отчёт собран');
  }

  function downloadCurrentReport() {
    const report = T.buildReport();
    T.downloadReportJSON(report);
    toast('Отчёт сохранён в JSON');
  }

  function renderHistory() {
    const list = T.loadHistory();
    if (!list.length) {
      el.historyList.innerHTML = '<p class="muted small">История пуста.</p>';
      return;
    }
    el.historyList.innerHTML = list.map((h) =>
      `<div class="history-item">
        <div class="row">
          <span class="muted small">${new Date(h.ts).toLocaleString()}</span>
          <span class="score">${h.score != null ? h.score : '—'} / 100</span>
        </div>
      </div>`
    ).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Startup                                                            */
  /* ------------------------------------------------------------------ */
  function checkSupport() {
    if (!window.AudioContext && !window.webkitAudioContext) {
      $('#unsupported').classList.remove('hidden');
      return false;
    }
    return true;
  }

  async function startup() {
    initTheme();
    if (!checkSupport()) return;

    // Роутинг
    const initial = location.hash.replace('#', '') || 'dashboard';
    navigate(initial);

    // Устройства
    await refreshDevices();
    navigator.mediaDevices && navigator.mediaDevices.addEventListener &&
      navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    // История
    renderHistory();

    // Ресайз канвасов
    resizeAllCanvases();

    // Инициализация UI-полей генератора
    el.genFreqVal.textContent = el.genFreq.value;
    el.genVolVal.textContent = el.genVol.value;

    // Показ скрытого блока поддержки
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#btn-request-mic').disabled = true;
      $('#btn-request-mic').title = 'getUserMedia недоступен';
    }
  }

  /* Глобальные ошибки */
  window.addEventListener('error', (e) => {
    console.error('[global error]', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup);
  } else {
    startup();
  }
})();