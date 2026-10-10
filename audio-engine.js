/* ==========================================================================
   audio-engine.js
   Обёртка над Web Audio API. Всё выполняется локально в браузере.
   ========================================================================== */

(function (global) {
  'use strict';

  const SAFETY_CEILING_DB = -3;   // общий потолок мастер-гейна
  const DEFAULT_FADE = 0.02;      // 20 мс для плавного вкл/выкл (без щелчков)

  /* ----------------------------------------------------------------------- */
  /* Вспомогательные: дБ ↔ линейная амплитуда                                 */
  /* ----------------------------------------------------------------------- */
  const dbToGain = (db) => Math.pow(10, db / 20);
  const gainToDb = (g) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

  /* ----------------------------------------------------------------------- */
  /* Основной класс                                                           */
  /* ----------------------------------------------------------------------- */
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.master = null;              // финальный gain перед destination
      this.limiter = null;             // DynamicsCompressor как «предохранитель»
      this.splitterL = null;           // входы для L/R
      this.splitterR = null;
      this.merger = null;              // ChannelMergerNode(2)
      this.panner = null;              // для pan-sweep
      this.panInputL = null;
      this.panInputR = null;

      // активные источники (чтобы уметь останавливать все разом)
      this._activeSources = new Set();

      // микрофон
      this.micStream = null;
      this.micSource = null;
      this.micAnalyser = null;
      this.micGain = null;
      this.micConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      this._micListeners = new Set();
      this._micRafId = null;
      this._micBuffer = null;

      // калибровка
      this.refDb = null;               // опорный уровень (в дБ) из SPL-теста

      // событие готовности
      this._readyResolvers = [];
    }

    /* ------------------------------------------------------------------- */
    /* Инициализация аудио-контекста                                        */
    /* ------------------------------------------------------------------- */
    async init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') await this.ctx.resume();
        return this.ctx;
      }
      if (!global.AudioContext && !global.webkitAudioContext) {
        throw new Error('Web Audio API не поддерживается этим браузером');
      }
      const Ctor = global.AudioContext || global.webkitAudioContext;
      this.ctx = new Ctor({ latencyHint: 'interactive' });

      // Граф:
      //   [источники] → merger(2) → panner → master(gain) → limiter → destination
      this.merger  = this.ctx.createChannelMerger(2);
      this.panner  = this.ctx.createStereoPanner();
      this.master  = this.ctx.createGain();
      this.master.gain.value = 1.0;

      // Мягкий предохранитель от перегруза по амплитуде
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = SAFETY_CEILING_DB;
      this.limiter.knee.value = 3;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.1;

      this.merger.connect(this.panner);
      this.panner.connect(this.master);
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      // Автопауза при сворачивании вкладки (экономия CPU)
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend().catch(() => {});
        else this.ctx.resume().catch(() => {});
      });

      // Резолвим всех ожидающих
      this._readyResolvers.forEach((r) => r(this.ctx));
      this._readyResolvers.length = 0;
      return this.ctx;
    }

    whenReady() {
      if (this.ctx) return Promise.resolve(this.ctx);
      return new Promise((res) => this._readyResolvers.push(res));
    }

    /* ------------------------------------------------------------------- */
    /* Создание источника для L или R (по флагам {left, right})             */
    /* ------------------------------------------------------------------- */
    _applyChannelRouting(node, { left = true, right = true } = {}) {
      // node → merger channel 0 (L) и/или channel 1 (R)
      if (left)  node.connect(this.merger, 0, 0);
      if (right) node.connect(this.merger, 0, 1);
      // Заглушка: если только один канал — второй merger-вход «тихий»
      // (merger сам подмешает ноль, если к нему ничего не подключено на этом входе)
    }

    /* ------------------------------------------------------------------- */
    /* Одноразовый тон (с автофейдом)                                       */
    /* ------------------------------------------------------------------- */
    playTone({
      freq = 440,
      type = 'sine',
      duration = 1.0,
      gainDb = -20,
      left = true,
      right = true,
      pan = 0,             // -1..+1 (используется если left && right)
      attack = DEFAULT_FADE,
      release = DEFAULT_FADE
    } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      const peak = dbToGain(gainDb);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(peak, now + attack);
      g.gain.setValueAtTime(peak, now + duration - release);
      g.gain.linearRampToValueAtTime(0, now + duration);

      osc.connect(g);

      if (left && right && pan !== 0) {
        // Панорамирование: через отдельный StereoPanner
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p);
        p.connect(this.master);
        this._register(p);
      } else {
        this._applyChannelRouting(g, { left, right });
      }

      this._register(osc);
      osc.start(now);
      osc.stop(now + duration + 0.02);
      osc.onended = () => {
        try { g.disconnect(); } catch (_) {}
        this._activeSources.delete(osc);
      };
      return { osc, gain: g, endTime: now + duration };
    }

    /* ------------------------------------------------------------------- */
    /* Длительный тон (ручной старт/стоп)                                   */
    /* ------------------------------------------------------------------- */
    startTone({
      freq = 440,
      type = 'sine',
      gainDb = -20,
      left = true,
      right = true,
      pan = 0
    } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      const peak = dbToGain(gainDb);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(peak, now + DEFAULT_FADE);

      osc.connect(g);

      if (left && right && pan !== 0) {
        const p = this.ctx.createStereoPanner();
        p.pan.value = pan;
        g.connect(p);
        p.connect(this.master);
        this._register(p);
      } else {
        this._applyChannelRouting(g, { left, right });
      }

      osc.start(now);
      this._register(osc);

      const handle = {
        osc, gain: g,
        setFreq(f) { osc.frequency.setTargetAtTime(f, this.ctxNow(), 0.01); },
        ctxNow: () => this.ctx.currentTime,
        setGainDb(db) {
          const t = this.ctx.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setTargetAtTime(dbToGain(db), t, 0.02);
        },
        setPan(p) {
          if (pannerIsLocal(p)) p.pan.setTargetAtTime(p, this.ctx.currentTime, 0.02);
          function pannerIsLocal(x) { return x !== null && x !== undefined; }
        },
        stop: () => {
          const t = this.ctx.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setTargetAtTime(0, t, 0.02);
          try { osc.stop(t + 0.15); } catch (_) {}
        }
      };
      return handle;
    }

    /* ------------------------------------------------------------------- */
    /* Свип (линейный или логарифмический)                                  */
    /* ------------------------------------------------------------------- */
    startSweep({
      from = 20,
      to = 20000,
      duration = 15,
      gainDb = -20,
      curve = 'log',       // 'log' | 'linear'
      left = true,
      right = true,
      onTick = null        // (freq, progress) => void
    } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';

      const peak = dbToGain(gainDb);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(peak, now + 0.05);
      g.gain.setValueAtTime(peak, now + duration - 0.05);
      g.gain.linearRampToValueAtTime(0, now + duration);

      if (curve === 'log') {
        osc.frequency.setValueAtTime(from, now);
        osc.frequency.exponentialRampToValueAtTime(to, now + duration);
      } else {
        osc.frequency.setValueAtTime(from, now);
        osc.frequency.linearRampToValueAtTime(to, now + duration);
      }

      osc.connect(g);
      this._applyChannelRouting(g, { left, right });

      osc.start(now);
      osc.stop(now + duration + 0.02);
      this._register(osc);

      let rafId = null;
      const tick = () => {
        if (!this.ctx || !osc) return;
        const elapsed = this.ctx.currentTime - now;
        const p = Math.min(1, Math.max(0, elapsed / duration));
        let f;
        if (curve === 'log') {
          f = from * Math.pow(to / from, p);
        } else {
          f = from + (to - from) * p;
        }
        if (onTick) onTick(f, p);
        if (p < 1) rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);

      osc.onended = () => {
        if (rafId) cancelAnimationFrame(rafId);
        try { g.disconnect(); } catch (_) {}
        this._activeSources.delete(osc);
      };

      return {
        osc,
        stop: () => {
          try { osc.stop(); } catch (_) {}
          if (rafId) cancelAnimationFrame(rafId);
        }
      };
    }

    /* ------------------------------------------------------------------- */
    /* Impulse (для latency/echo)                                           */
    /* ------------------------------------------------------------------- */
    playImpulse({ gainDb = -6, left = true, right = true, duration = 0.005 } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const ch = buf.getChannelData(0);
      // Короткий «щелчок» с окном Ханна — почти идеальный импульс
      for (let i = 0; i < len; i++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
        ch[i] = w * (Math.random() * 2 - 1);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const g = this.ctx.createGain();
      g.gain.value = dbToGain(gainDb);
      src.connect(g);
      this._applyChannelRouting(g, { left, right });
      src.start(now);
      this._register(src);
      src.onended = () => {
        try { g.disconnect(); } catch (_) {}
        this._activeSources.delete(src);
      };
      return { src, startTime: now, endTime: now + duration };
    }

    /* ------------------------------------------------------------------- */
    /* Шум (белый / розовый / коричневый)                                   */
    /* ------------------------------------------------------------------- */
    startNoise({ type = 'white', gainDb = -20, left = true, right = true } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const bufferSeconds = 2;
      const len = this.ctx.sampleRate * bufferSeconds;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);

      if (type === 'white') {
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      } else if (type === 'pink') {
        // Paul Kellet's pink noise approximation
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else { // brown
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          data[i] = last * 3.5;
        }
      }

      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = this.ctx.createGain();
      g.gain.value = dbToGain(gainDb);
      src.connect(g);
      this._applyChannelRouting(g, { left, right });
      src.start(now);
      this._register(src);
      return {
        src,
        stop: () => {
          const t = this.ctx.currentTime;
          g.gain.cancelScheduledValues(t);
          g.gain.setTargetAtTime(0, t, 0.05);
          try { src.stop(t + 0.2); } catch (_) {}
        }
      };
    }

    /* ------------------------------------------------------------------- */
    /* DTMF                                                                 */
    /* ------------------------------------------------------------------- */
    playDTMF(digit, { gainDb = -12, duration = 0.35 } = {}) {
      const TABLE = {
        '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
        '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
        '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
        '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
      };
      const pair = TABLE[digit];
      if (!pair) return null;
      const [f1, f2] = pair;
      const now = this.ctx.currentTime;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(dbToGain(gainDb), now + 0.01);
      g.gain.setValueAtTime(dbToGain(gainDb), now + duration - 0.02);
      g.gain.linearRampToValueAtTime(0, now + duration);
      this._applyChannelRouting(g, { left: true, right: true });

      [f1, f2].forEach((f) => {
        const o = this.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.connect(g);
        o.start(now);
        o.stop(now + duration + 0.02);
        this._register(o);
      });
      return { endTime: now + duration };
    }

    /* ------------------------------------------------------------------- */
    /* Pan-sweep: плавное перемещение L → R                                 */
    /* ------------------------------------------------------------------- */
    startPanSweep({ freq = 440, gainDb = -20, duration = 4 } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const p = this.ctx.createStereoPanner();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.value = dbToGain(gainDb);
      p.pan.setValueAtTime(-1, now);
      p.pan.linearRampToValueAtTime(1, now + duration);
      osc.connect(g); g.connect(p); p.connect(this.master);
      osc.start(now);
      osc.stop(now + duration + 0.05);
      this._register(osc);
      osc.onended = () => {
        try { g.disconnect(); p.disconnect(); } catch (_) {}
        this._activeSources.delete(osc);
      };
      return { stop: () => { try { osc.stop(); } catch (_) {} } };
    }

    /* ------------------------------------------------------------------- */
    /* Противофаза: инверсия правого канала                                 */
    /* ------------------------------------------------------------------- */
    startPhaseTone({ freq = 440, gainDb = -20, invertRight = false } = {}) {
      if (!this.ctx) throw new Error('AudioContext не запущен');
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gL = this.ctx.createGain();
      const gR = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const peak = dbToGain(gainDb);
      gL.gain.value = peak;
      gR.gain.value = invertRight ? -peak : peak;

      osc.connect(gL);
      osc.connect(gR);
      gL.connect(this.merger, 0, 0); // L
      gR.connect(this.merger, 0, 1); // R

      osc.start(now);
      this._register(osc);
      return {
        stop: () => { try { osc.stop(); } catch (_) {} }
      };
    }

    /* ------------------------------------------------------------------- */
    /* Микрофон                                                             */
    /* ------------------------------------------------------------------- */
    async startMic(overrides = null) {
      if (overrides) Object.assign(this.micConstraints, overrides);
      if (this.micStream) return this.micStream;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia недоступен');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this.micConstraints.echoCancellation,
          noiseSuppression: this.micConstraints.noiseSuppression,
          autoGainControl: this.micConstraints.autoGainControl
        },
        video: false
      });
      await this.whenReady();
      this.micStream = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micAnalyser = this.ctx.createAnalyser();
      this.micAnalyser.fftSize = 4096;
      this.micAnalyser.smoothingTimeConstant = 0.6;
      this.micGain = this.ctx.createGain();
      this.micGain.gain.value = 1.0;
      this.micSource.connect(this.micGain);
      this.micGain.connect(this.micAnalyser);
      // ВАЖНО: micAnalyser НЕ подключён к destination — иначе будет фидбэк
      return stream;
    }

    async stopMic() {
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
      }
      try { this.micSource && this.micSource.disconnect(); } catch (_) {}
      try { this.micGain && this.micGain.disconnect(); } catch (_) {}
      try { this.micAnalyser && this.micAnalyser.disconnect(); } catch (_) {}
      this.micStream = null;
      this.micSource = null;
      this.micGain = null;
      this.micAnalyser = null;
    }

    /* Подписка на поток данных из микрофона (RMS, частота и т.п.) */
    onMicFrame(cb) {
      this._micListeners.add(cb);
      this._ensureMicLoop();
      return () => this._micListeners.delete(cb);
    }

    _ensureMicLoop() {
      if (this._micRafId) return;
      const buf = new Float32Array(this.micAnalyser ? this.micAnalyser.fftSize : 2048);
      const freqBuf = new Uint8Array(this.micAnalyser ? this.micAnalyser.frequencyBinCount : 1024);

      const loop = () => {
        if (!this.micAnalyser) {
          this._micRafId = null;
          return;
        }
        this.micAnalyser.getFloatTimeDomainData(buf);
        this.micAnalyser.getByteFrequencyData(freqBuf);

        let sum = 0, peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sum += v * v;
          const a = Math.abs(v);
          if (a > peak) peak = a;
        }
        const rms = Math.sqrt(sum / buf.length);
        const rmsDb = gainToDb(rms);
        const peakDb = gainToDb(peak);

        const frame = { time: buf, freq: freqBuf, rms, rmsDb, peak, peakDb };
        this._micListeners.forEach((fn) => {
          try { fn(frame); } catch (e) { console.error(e); }
        });
        this._micRafId = requestAnimationFrame(loop);
      };
      this._micRafId = requestAnimationFrame(loop);
    }

    /* Запись фрагмента с микрофона в AudioBuffer */
    async recordMic(seconds = 3) {
      await this.startMic();
      const chunks = [];
      const recorder = new MediaRecorder(this.micStream);
      return new Promise((resolve, reject) => {
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onerror = (e) => reject(e.error || new Error('recorder error'));
        recorder.onstop = async () => {
          try {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const arr = await blob.arrayBuffer();
            const decoded = await this.ctx.decodeAudioData(arr.slice(0));
            resolve({ buffer: decoded, blob });
          } catch (err) {
            reject(err);
          }
        };
        recorder.start();
        setTimeout(() => { try { recorder.stop(); } catch (_) {} }, seconds * 1000);
      });
    }

    /* Скачивание AudioBuffer как WAV */
    bufferToWavBlob(buffer) {
      const numCh = buffer.numberOfChannels;
      const len = buffer.length;
      const sr = buffer.sampleRate;
      const bytesPerSample = 2;
      const blockAlign = numCh * bytesPerSample;
      const dataSize = len * blockAlign;
      const ab = new ArrayBuffer(44 + dataSize);
      const view = new DataView(ab);

      const writeStr = (off, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
      };
      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numCh, true);
      view.setUint32(24, sr, true);
      view.setUint32(28, sr * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data');
      view.setUint32(40, dataSize, true);

      const channels = [];
      for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
      let off = 44;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < numCh; c++) {
          let s = Math.max(-1, Math.min(1, channels[c][i]));
          view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          off += 2;
        }
      }
      return new Blob([ab], { type: 'audio/wav' });
    }

    /* ------------------------------------------------------------------- */
    /* Анализ: FFT мгновенный снимок (для измерений)                        */
    /* ------------------------------------------------------------------- */
    async captureSpectrum({ seconds = 0.3 } = {}) {
      await this.startMic();
      const N = this.micAnalyser.fftSize;
      const buf = new Float32Array(N);
      const freq = new Uint8Array(this.micAnalyser.frequencyBinCount);

      // Небольшая задержка для стабилизации
      await new Promise((r) => setTimeout(r, seconds * 1000));
      this.micAnalyser.getFloatTimeDomainData(buf);
      this.micAnalyser.getByteFrequencyData(freq);
      return {
        time: buf,
        freq,
        sampleRate: this.ctx.sampleRate,
        fftSize: N
      };
    }

    /* ------------------------------------------------------------------- */
    /* Утилиты                                                              */
    /* ------------------------------------------------------------------- */
    _register(node) {
      this._activeSources.add(node);
    }

    stopAll() {
      this._activeSources.forEach((n) => {
        try { n.stop && n.stop(); } catch (_) {}
        try { n.disconnect && n.disconnect(); } catch (_) {}
      });
      this._activeSources.clear();
    }

    setMasterGainDb(db) {
      if (!this.master) return;
      this.master.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.02);
    }

    /* Информация о среде — sampleRate, базовая задержка и т.д. */
    info() {
      if (!this.ctx) return null;
      return {
        sampleRate: this.ctx.sampleRate,
        state: this.ctx.state,
        baseLatency: this.ctx.baseLatency || null,
        outputLatency: this.ctx.outputLatency || null,
        maxChannelCount: this.ctx.destination.maxChannelCount,
        channelCount: this.ctx.destination.channelCount
      };
    }

    /* ------------------------------------------------------------------- */
    /* Кросс-корреляция для RTT                                             */
    /* ------------------------------------------------------------------- */
    estimateDelayMs(emittedBuf, recordedBuf) {
      const a = emittedBuf;
      const b = recordedBuf;
      const searchLen = Math.min(recorder_useful(b.length), a.length * 4 + 1000);
      // Ограниченное окно поиска (от 0 до 2000 мс)
      const maxLag = Math.min(
        b.length - a.length - 1,
        Math.floor(this.ctx.sampleRate * 2.0)
      );
      if (maxLag <= 0) return null;

      let bestLag = 0;
      let bestScore = -Infinity;
      const step = 1;
      for (let lag = 0; lag < maxLag; lag += step) {
        let sum = 0;
        // грубая корреляция на выборке
        for (let i = 0; i < a.length; i += 16) {
          sum += a[i] * b[lag + i];
        }
        if (sum > bestScore) {
          bestScore = sum;
          bestLag = lag;
        }
      }
      return (bestLag / this.ctx.sampleRate) * 1000;

      function recorder_useful(x) { return x; }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Экспорт                                                                  */
  /* ----------------------------------------------------------------------- */
  const engine = new AudioEngine();
  global.AudioEngine = engine;
  global.AudioEngineUtils = { dbToGain, gainToDb };

})(window);