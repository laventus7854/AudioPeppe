/* ==========================================================================
   tests.js — реализация тестов
   Зависит от audio-engine.js (window.AudioEngine)
   ========================================================================== */

(function (global) {
  'use strict';

  const E = global.AudioEngine;
  const { dbToGain, gainToDb } = global.AudioEngineUtils;

  /* ------------------------------------------------------------------ */
  /* Хранилище результатов                                              */
  /* ------------------------------------------------------------------ */
  const results = {};   // { testId: { label, value, verdict, score, note } }

  function saveResult(id, label, value, verdict = 'info', score = null, note = '') {
    results[id] = { label, value, verdict, score, note, ts: Date.now() };
    global.dispatchEvent(new CustomEvent('test:result', { detail: results[id] }));
  }

  /* ------------------------------------------------------------------ */
  /* Утилиты                                                            */
  /* ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // RMS по окну Float32
  function rms(arr) {
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    return Math.sqrt(s / arr.length);
  }

  // Peak
  function peak(arr) {
    let p = 0;
    for (let i = 0; i < arr.length; i++) {
      const a = Math.abs(arr[i]);
      if (a > p) p = a;
    }
    return p;
  }

  // Простая реализация FFT (radix-2, in-place)
  function fft(re, im) {
    const n = re.length;
    // bit-reversal
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
          const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
          re[i + k] = uRe + vRe;
          im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe;
          im[i + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          const nextIm = curRe * wIm + curIm * wRe;
          curRe = nextRe; curIm = nextIm;
        }
      }
    }
  }

  // Спектр амплитуд из временного окна
  function amplitudeSpectrum(timeArr) {
    const N = 1 << Math.floor(Math.log2(timeArr.length));
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    // окно Ханна
    for (let i = 0; i < N; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
      re[i] = timeArr[i] * w;
    }
    fft(re, im);
    const mag = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / (N / 2);
    }
    return { mag, N };
  }

  // Уровень (дБ относительно полной шкалы, 0 dBFS = 1.0)
  function levelDb(samples) { return gainToDb(rms(samples)); }
  function peakDb(samples) { return gainToDb(peak(samples)); }

  // ------------------------------------------------------------------
  // 1. КАНАЛЫ
  // ------------------------------------------------------------------

  // Тест: только L / только R / оба канала
  async function testChannel(which) {
    await E.init();
    const opts = { freq: 440, duration: 1.2, gainDb: -18, type: 'sine' };
    if (which === 'left')  E.playTone({ ...opts, left: true,  right: false });
    if (which === 'right') E.playTone({ ...opts, left: false, right: true });
    if (which === 'both')  E.playTone({ ...opts, left: true,  right: true });
    await sleep(1400);

    // Верификация по микрофону (опционально, если разрешён)
    let detected = null;
    if (E.micAnalyser) {
      const frame = await E.captureSpectrum({ seconds: 0.2 });
      detected = levelDb(frame.time);
    }
    const map = {
      left:  { label: 'Левый канал',   value: 'Воспроизведён тон 440 Гц (L)', verdict: 'ok', score: 100 },
      right: { label: 'Правый канал',  value: 'Воспроизведён тон 440 Гц (R)', verdict: 'ok', score: 100 },
      both:  { label: 'Оба канала',    value: 'Воспроизведён тон 440 Гц (L+R)', verdict: 'ok', score: 100 }
    };
    saveResult('ch-' + which, map[which].label, map[which].value, map[which].verdict, map[which].score,
      'Если вы не слышите звук в соответствующем ухе/колонке — канал неисправен или кабель не подключён.');
    return map[which];
  }

  // Пинг-понг
  let _pingPongTimer = null;
  function startPingPong(intervalMs = 500) {
    stopPingPong();
    const step = () => {
      E.playTone({ freq: 880, duration: intervalMs / 1000 * 0.9, gainDb: -18, left: true,  right: false });
      setTimeout(() => {
        E.playTone({ freq: 880, duration: intervalMs / 1000 * 0.9, gainDb: -18, left: false, right: true });
      }, intervalMs);
      _pingPongTimer = setTimeout(step, intervalMs * 2);
    };
    step();
  }
  function stopPingPong() {
    if (_pingPongTimer) clearTimeout(_pingPongTimer);
    _pingPongTimer = null;
    E.stopAll();
  }

  // Pan-sweep
  async function testPanSweep() {
    await E.init();
    E.startPanSweep({ freq: 440, gainDb: -18, duration: 4 });
    await sleep(4400);
    saveResult('pan-sweep', 'Pan Sweep', 'Прозвучал переход L → R за 4 с', 'ok', 100,
      'Убедитесь, что звук «проходит» от левого уха к правому плавно, без провала в центре.');
  }

  // Crosstalk через микрофон
  async function testCrosstalk(durationSec = 3) {
    await E.init();
    if (!E.micStream) { await E.startMic(); }
    // Сначала тишина
    await sleep(300);
    const silent = await E.captureSpectrum({ seconds: 0.3 });
    const silenceLevel = levelDb(silent.time);

    // Подача в левый канал
    E.playTone({ freq: 1000, duration: durationSec, gainDb: -12, left: true, right: false });
    await sleep(durationSec * 1000 * 0.4); // ждём середины
    const measure = await E.captureSpectrum({ seconds: 0.3 });
    const sigLevel = levelDb(measure.time);

    const diffDb = sigLevel - silenceLevel;
    const verdict = diffDb > 20 ? 'ok' : diffDb > 10 ? 'warn' : 'info';
    const note = 'Значимая цифра — если при подаче в L микрофон у правого драйвера фиксирует уровень выше шума на >20 дБ, это норма (перекрёстные помехи в разумных пределах).';
    saveResult('crosstalk', 'Crosstalk (L→R)',
      `Уровень: ${sigLevel.toFixed(1)} дБFS, шум: ${silenceLevel.toFixed(1)} дБFS, разница: ${diffDb.toFixed(1)} дБ`,
      verdict, null, note);
    await sleep(durationSec * 1000 * 0.5);
  }

  // BT latency (round-trip через микрофон)
  async function testBtLatency() {
    await E.init();
    if (!E.micStream) { await E.startMic(); }
    // Подача импульса
    const impulseBuffer = await measureRoundTrip();
    const ms = impulseBuffer;
    if (ms == null) {
      saveResult('bt-latency', 'BT Latency', 'Не удалось измерить (нет сигнала в микрофоне)', 'info', null,
        'Убедитесь, что микрофон слышит воспроизведение и уровень достаточный.');
      return;
    }
    const verdict = ms < 20 ? 'ok' : ms < 100 ? 'info' : ms < 250 ? 'warn' : 'bad';
    const note = 'Bluetooth-кодеки обычно добавляют 100–300 мс. Проводные соединения — 5–30 мс.';
    saveResult('bt-latency', 'Round-trip latency', `${ms.toFixed(1)} мс`, verdict, null, note);
  }

  // Общая утилита: emit impulse + record → cross-correlation
  async function measureRoundTrip() {
    if (!E.ctx) await E.init();
    if (!E.micStream) await E.startMic();

    // Записываем 2 секунды, а на 300 мс — импульс
    const recPromise = E.recordMic(2);
    await sleep(300);
    const now = E.ctx.currentTime;
    E.playImpulse({ gainDb: -6, left: true, right: true });

    // Синтетический эталон импульса — воссоздадим такой же
    const impulseDur = 0.005;
    const len = Math.max(1, Math.floor(E.ctx.sampleRate * impulseDur));
    const emitted = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
      emitted[i] = w * 0.5; // амплитуда не важна для корреляции
    }

    const { buffer } = await recPromise;
    // Ищем пик в записанном сигнале: первая выборка с амплитудой > порог
    const data = buffer.getChannelData(0);
    const threshold = 0.02;
    let firstPeak = -1;
    // Начинаем с 250 мс, чтобы не поймать выброс микрофона
    const startSearch = Math.floor(E.ctx.sampleRate * 0.25);
    for (let i = startSearch; i < data.length; i++) {
      if (Math.abs(data[i]) > threshold) { firstPeak = i; break; }
    }
    if (firstPeak < 0) return null;
    // Импульс был подан через 300 мс после старта записи, но startSearch = 250 мс
    const emitAt = Math.floor(E.ctx.sampleRate * 0.3);
    const deltaSamples = firstPeak - emitAt;
    const ms = (deltaSamples / E.ctx.sampleRate) * 1000;
    return Math.max(0, ms);
  }

  // ------------------------------------------------------------------
  // 2. ЧАСТОТЫ
  // ------------------------------------------------------------------

  // Ручной генератор — управляется через app.js напрямую
  let _manualTone = null;
  async function startManualTone({ freq, type, gainDb, channel }) {
    await E.init();
    stopManualTone();
    const left = channel === 'both' || channel === 'left';
    const right = channel === 'both' || channel === 'right';
    _manualTone = E.startTone({ freq, type, gainDb, left, right });
  }
  function stopManualTone() {
    if (_manualTone) { _manualTone.stop(); _manualTone = null; }
  }
  function updateManualTone(patch) {
    if (!_manualTone) return;
    if (patch.freq != null) _manualTone.osc.frequency.setTargetAtTime(patch.freq, E.ctx.currentTime, 0.02);
    if (patch.gainDb != null) _manualTone.setGainDb(patch.gainDb);
    if (patch.type != null) _manualTone.osc.type = patch.type;
  }

  // Full sweep
  async function sweepFull(onTick) {
    await E.init();
    return new Promise((resolve) => {
      const sweep = E.startSweep({
        from: 20, to: 20000, duration: 15, gainDb: -20, curve: 'log',
        onTick: (f, p) => {
          if (onTick) onTick(f, p);
          if (p >= 1) {
            saveResult('sweep-full', 'Full sweep', 'Диапазон 20 Гц – 20 кГц пройден', 'ok', 100,
              'Отметьте, на каких участках вы услышали провалы или резкие усиления.');
            resolve();
          }
        }
      });
    });
  }

  async function sweepBass(onTick) {
    await E.init();
    return new Promise((resolve) => {
      const sweep = E.startSweep({
        from: 200, to: 20, duration: 10, gainDb: -18, curve: 'log',
        onTick: (f, p) => {
          if (onTick) onTick(f, p);
          if (p >= 1) {
            saveResult('sweep-bass', 'Свип низов', 'Пройдено 200 → 20 Гц', 'ok', 100,
              'Нижняя граница — частота, на которой вы перестали слышать тон.');
            resolve();
          }
        }
      });
    });
  }

  async function sweepSub(onTick) {
    await E.init();
    return new Promise((resolve) => {
      const sweep = E.startSweep({
        from: 100, to: 20, duration: 8, gainDb: -14, curve: 'linear',
        onTick: (f, p) => {
          if (onTick) onTick(f, p);
          if (p >= 1) {
            saveResult('sweep-sub', 'Свип сабвуфера', 'Пройдено 100 → 20 Гц', 'ok', 100,
              'Если слышно только «дыхание»/вибрацию — воспроизведение низа близко к пределу.');
            resolve();
          }
        }
      });
    });
  }

  // High freq single tones
  async function playHighTone(freq) {
    await E.init();
    E.playTone({ freq, duration: 1.5, gainDb: -18, type: 'sine' });
    await sleep(1600);
    saveResult('hf-' + freq, 'ВЧ ' + (freq / 1000) + ' кГц', 'Тон воспроизведён', 'ok', 100,
      'Отметьте, слышите ли вы тон. 16+ кГц слышат далеко не все — это норма.');
  }

  // Dead zones: медленный свип + анализ микрофоном, ищем провалы в спектре
  async function testDeadZones(onProgress) {
    await E.init();
    if (!E.micStream) await E.startMic();
    const points = [];
    const from = 50, to = 15000, duration = 10;
    const sweepPromise = new Promise((resolve) => {
      E.startSweep({
        from, to, duration, gainDb: -12, curve: 'log',
        onTick: async (f, p) => {
          if (onProgress) onProgress(f, p);
          if (p >= 1) resolve();
        }
      });
    });
    // Параллельно снимаем снимки спектра
    const snapshots = [];
    const snapTimer = setInterval(async () => {
      if (!E.micAnalyser) return;
      const frame = await E.captureSpectrum({ seconds: 0.05 });
      snapshots.push({ ts: performance.now(), levelDb: levelDb(frame.time) });
    }, 200);

    await sweepPromise;
    clearInterval(snapTimer);

    // Анализ: находим локальные минимумы
    const levels = snapshots.map((s) => s.levelDb);
    const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
    const dips = [];
    for (let i = 2; i < levels.length - 2; i++) {
      if (levels[i] < mean - 10 && levels[i] < levels[i - 1] && levels[i] < levels[i + 1]) {
        dips.push({ idx: i, drop: mean - levels[i] });
      }
    }
    // Ограничим количество
    const top = dips.sort((a, b) => b.drop - a.drop).slice(0, 5);

    const verdict = top.length === 0 ? 'ok' : top.length < 3 ? 'info' : 'warn';
    const msg = top.length === 0
      ? 'Резких провалов не обнаружено.'
      : `Найдено ${top.length} зон возможного падения уровня. Приблизительные частоты: ` +
        top.map((d) => {
          const frac = d.idx / levels.length;
          const f = from * Math.pow(to / from, frac);
          return `${f.toFixed(0)} Гц`;
        }).join(', ');
    saveResult('dead-zones', 'Мёртвые зоны', msg, verdict, null,
      'Микрофон должен быть расположен рядом с драйвером. Провалы могут быть особенностью АЧХ или помещением.');
  }

  // Резонансы — то же самое, но ищем подъёмы
  async function testResonances(onProgress) {
    await E.init();
    if (!E.micStream) await E.startMic();
    const from = 50, to = 15000, duration = 10;
    const snapshots = [];
    const snapTimer = setInterval(async () => {
      if (!E.micAnalyser) return;
      const frame = await E.captureSpectrum({ seconds: 0.05 });
      snapshots.push(levelDb(frame.time));
    }, 200);

    await new Promise((resolve) => {
      E.startSweep({
        from, to, duration, gainDb: -12, curve: 'log',
        onTick: (f, p) => {
          if (onProgress) onProgress(f, p);
          if (p >= 1) resolve();
        }
      });
    });
    clearInterval(snapTimer);

    const mean = snapshots.reduce((a, b) => a + b, 0) / snapshots.length;
    const peaks = [];
    for (let i = 2; i < snapshots.length - 2; i++) {
      if (snapshots[i] > mean + 8 && snapshots[i] > snapshots[i - 1] && snapshots[i] > snapshots[i + 1]) {
        peaks.push({ idx: i, rise: snapshots[i] - mean });
      }
    }
    const top = peaks.sort((a, b) => b.rise - a.rise).slice(0, 5);
    const verdict = top.length === 0 ? 'ok' : top.length < 3 ? 'info' : 'warn';
    const msg = top.length === 0
      ? 'Резонансов не обнаружено.'
      : `Найдено ${top.length} пиков. Приблизительные частоты: ` +
        top.map((d) => {
          const frac = d.idx / snapshots.length;
          const f = from * Math.pow(to / from, frac);
          return `${f.toFixed(0)} Гц`;
        }).join(', ');
    saveResult('resonances', 'Резонансы', msg, verdict, null,
      'Пики могут возникать из-за особенностей комнаты или корпуса устройства.');
  }

  // ------------------------------------------------------------------
  // 3. ФАЗА И ПОЛЯРНОСТЬ
  // ------------------------------------------------------------------

  async function testPhase(invert) {
    await E.init();
    E.startPhaseTone({ freq: 200, gainDb: -18, invertRight: invert });
    await sleep(2500);
    E.stopAll();
    saveResult(
      invert ? 'phase-out' : 'phase-in',
      invert ? 'Противофаза' : 'In-Phase',
      invert ? 'Прозвучал тон с инвертированным R' : 'Прозвучал синфазный тон',
      'ok', 100,
      invert
        ? 'При противофазе центр звуковой сцены должен «пропасть». Если бас не пропадает — динамики уже в противофазе.'
        : 'При синфазном сигнале центр плотный. Если при переходе в противофазу бас «пропал» — полярность в порядке.'
    );
  }

  async function testPolarity(invertRight) {
    await E.init();
    // Подаём низкочастотный тон — на нём эффект инверсии максимален
    E.startPhaseTone({ freq: 80, gainDb: -18, invertRight });
    await sleep(2500);
    E.stopAll();
    saveResult(
      invertRight ? 'polarity-invert' : 'polarity-normal',
      invertRight ? 'Инверсия R' : 'Норма',
      invertRight ? 'Прозвучал тон с инверсией правого канала' : 'Прозвучал тон без инверсии',
      'ok', 100,
      'Если при инверсии бас резко «пропадает» — оба динамика подключены в правильной полярности. Если нет — полярность одного динамика перепутана.'
    );
  }

  async function testHeadphonePhase() {
    await E.init();
    // Импульсы поочерёдно
    for (let i = 0; i < 3; i++) {
      E.playImpulse({ gainDb: -12, left: true, right: false });
      await sleep(400);
      E.playImpulse({ gainDb: -12, left: false, right: true });
      await sleep(400);
    }
    saveResult('hp-phase', 'Фазировка наушников',
      'Прозвучали импульсы поочерёдно L/R', 'ok', 100,
      'Импульс должен локализоваться строго слева или строго справа. Если «размазывается» — проверьте подключение драйверов (для кастомных наушников).');
  }

  // ------------------------------------------------------------------
  // 4. НАУШНИКИ
  // ------------------------------------------------------------------

  // АЧХ: loopback-метод, микрофон рядом с драйвером
  async function testHeadphoneFR(onProgress) {
    await E.init();
    if (!E.micStream) await E.startMic();

    const from = 50, to = 15000, duration = 12;
    const points = [];

    // Параллельно снимки
    const snapTimer = setInterval(async () => {
      if (!E.micAnalyser) return;
      const frame = await E.captureSpectrum({ seconds: 0.03 });
      points.push({ ts: performance.now(), level: levelDb(frame.time) });
    }, 150);

    await new Promise((resolve) => {
      E.startSweep({
        from, to, duration, gainDb: -12, curve: 'log',
        onTick: (f, p) => { if (onProgress) onProgress(f, p); if (p >= 1) resolve(); }
      });
    });
    clearInterval(snapTimer);

    // Нормализация: вычитаем средний уровень
    const levels = points.map((p) => p.level);
    if (levels.length === 0) {
      saveResult('hp-fr', 'АЧХ наушников', 'Нет данных микрофона', 'info', null, '');
      return null;
    }
    const max = Math.max(...levels);
    const norm = levels.map((l) => l - max);

    saveResult('hp-fr', 'АЧХ наушников',
      `Измерено ${points.length} точек, диапазон ${(max - Math.min(...levels)).toFixed(1)} дБ`,
      'ok', null,
      'График относительный (без абсолютной калибровки), но форма АЧХ отражает реальную картину.');

    // Возвращаем кривую для отрисовки
    return {
      freqs: points.map((_, i) => from * Math.pow(to / from, i / (points.length - 1))),
      levels: norm
    };
  }

  // THD 1 кГц
  async function testTHD() {
    await E.init();
    if (!E.micStream) await E.startMic();

    // Подача синуса 1 кГц
    const tone = E.startTone({ freq: 1000, type: 'sine', gainDb: -12, left: true, right: true });
    await sleep(700);
    const frame = await E.captureSpectrum({ seconds: 0.5 });
    tone.stop();
    await sleep(200);

    const { mag, N } = amplitudeSpectrum(frame.time);
    const sr = E.ctx.sampleRate;
    const binHz = sr / N;
    const binFor = (f) => Math.round(f / binHz);

    // Фундаментал 1 кГц — ищем пик около него
    const searchRange = (target) => {
      const c = binFor(target);
      let best = -1, bestIdx = c;
      for (let i = Math.max(1, c - 5); i <= Math.min(mag.length - 1, c + 5); i++) {
        if (mag[i] > best) { best = mag[i]; bestIdx = i; }
      }
      return best;
    };

    const f0 = searchRange(1000);
    const h2 = searchRange(2000);
    const h3 = searchRange(3000);
    const h4 = searchRange(4000);
    const h5 = searchRange(5000);

    if (f0 <= 0) {
      saveResult('hp-thd', 'THD', 'Не удалось зафиксировать фундаментал', 'info', null,
        'Проверьте, что микрофон слышит воспроизведение.');
      return;
    }

    const thdRatio = Math.sqrt(h2 * h2 + h3 * h3 + h4 * h4 + h5 * h5) / f0;
    const thdPct = thdRatio * 100;
    const thdDb = 20 * Math.log10(thdRatio || 1e-6);

    let verdict = 'ok';
    if (thdPct > 5) verdict = 'warn';
    if (thdPct > 15) verdict = 'bad';

    saveResult('hp-thd', 'THD @1 кГц',
      `THD ≈ ${thdPct.toFixed(2)} % (${thdDb.toFixed(1)} дБ)`,
      verdict,
      clamp(100 - thdPct * 5, 0, 100),
      'Наушники обычно дают <1 % THD. Значения выше 5 % указывают на искажения или перегрузку микрофона.');
  }

  // Тест на «пробитый» динамик
  async function testCrackle() {
    await E.init();
    E.playTone({ freq: 60, duration: 1.0, gainDb: -10, type: 'sine' });
    await sleep(1100);
    E.playTone({ freq: 120, duration: 0.5, gainDb: -10, type: 'sine' });
    await sleep(600);
    // Свип средних частот с усиленным уровнем
    await new Promise((resolve) => {
      E.startSweep({ from: 100, to: 5000, duration: 6, gainDb: -10, curve: 'log',
        onTick: (f, p) => { if (p >= 1) resolve(); } });
    });
    saveResult('hp-crack', 'Пробитый динамик',
      'Прозвучал усиленный свип и НЧ-тоны', 'info', null,
      'Слушайте внимательно: треск, хрип, «песок» на определённых частотах — признак повреждения драйвера.');
  }

  // Комфорт громкости
  let _loudState = null;
  async function startLoudTest() {
    await E.init();
    const startDb = -60;
    const stepDb = 1;
    const stepMs = 500;
    _loudState = { db: startDb, comfortDb: null, painDb: null, stopped: false };

    const tick = () => {
      if (!_loudState || _loudState.stopped) return;
      const { db } = _loudState;
      E.playTone({ freq: 1000, duration: stepMs / 1000, gainDb: db, type: 'sine' });
      _loudState.db = Math.min(0, db + stepDb);
      if (_loudState.db >= 0) {
        _loudState.stopped = true;
        return;
      }
      _loudState.timer = setTimeout(tick, stepMs);
    };
    tick();
  }
  function stopLoudTest() {
    if (_loudState) { _loudState.stopped = true; clearTimeout(_loudState.timer); }
    E.stopAll();
  }
  function markLoud(kind) {
    if (!_loudState) return;
    if (kind === 'comfort') _loudState.comfortDb = _loudState.db;
    if (kind === 'pain') {
      _loudState.painDb = _loudState.db;
      stopLoudTest();
      const c = _loudState.comfortDb;
      const p = _loudState.painDb;
      saveResult('hp-loud', 'Комфорт громкости',
        `Комфорт: ${c ?? '—'} дБFS; Порог боли: ${p ?? '—'} дБFS; Диапазон: ${c != null && p != null ? (p - c) + ' дБ' : '—'}`,
        'ok', null,
        'Разница между комфортом и болью < 15 дБ — признак ограниченного запаса по громкости (типично для дешёвых TWS).');
    }
  }

  // Собственный шум наушников
  async function testHeadphoneNoise() {
    await E.init();
    if (!E.micStream) await E.startMic();
    await sleep(200);
    // Просто слушаем тишину
    const frames = [];
    const stopAt = performance.now() + 5000;
    while (performance.now() < stopAt) {
      const frame = await E.captureSpectrum({ seconds: 0.1 });
      frames.push(levelDb(frame.time));
      await sleep(100);
    }
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const verdict = avg < -70 ? 'ok' : avg < -55 ? 'info' : 'warn';
    saveResult('hp-noise', 'Собственный шум',
      `Средний уровень: ${avg.toFixed(1)} дБFS`,
      verdict, null,
      '< -70 дБFS — тихий тракт. > -55 дБFS — заметный шум/шипение, возможно из-за усилителя или помех.');
  }

  // ------------------------------------------------------------------
  // 5. ДИНАМИКИ / 5.1
  // ------------------------------------------------------------------

  // Тест каналов 5.1: эмулируем через StereoPanner + позиционные тона
  async function testSurround(channel) {
    await E.init();
    const map = {
      FL: { pan: -0.7, label: 'Front Left' },
      C:  { pan: 0,    label: 'Center' },
      FR: { pan: 0.7,  label: 'Front Right' },
      SL: { pan: -1,   label: 'Surround Left' },
      SR: { pan: 1,    label: 'Surround Right' },
      LFE:{ pan: 0,    label: 'Subwoofer (LFE)', freq: 40 }
    };
    const cfg = map[channel];
    if (!cfg) return;
    // Имитация: паннер + (для LFE) НЧ-тон
    const p = E.ctx.createStereoPanner();
    p.pan.value = cfg.pan;
    p.connect(E.master);
    const osc = E.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = cfg.freq || 1000;
    const g = E.ctx.createGain();
    g.gain.value = dbToGain(-15);
    osc.connect(g); g.connect(p);
    osc.start();
    osc.stop(E.ctx.currentTime + 1.2);
    setTimeout(() => { try { p.disconnect(); g.disconnect(); } catch (_) {} }, 1500);

    saveResult('surround-' + channel, 'Канал ' + cfg.label,
      'Тон воспроизведён', 'ok', 100,
      'Если при выборе канала звук идёт не из ожидаемой колонки — проверьте раскладку в системе/ресивере.');
    await sleep(1300);
  }

  // Кроссовер
  async function testCrossover(freq) {
    await E.init();
    E.playTone({ freq, duration: 1.5, gainDb: -18, type: 'sine' });
    await sleep(1600);
    saveResult('xover-' + freq, 'Кроссовер ' + freq + ' Гц',
      'Тон воспроизведён', 'ok', 100,
      'Если на частоте среза слышен провал или «шов» между сателлитом и сабом — кроссовер настроен некорректно.');
  }

  // Сцена: 8 позиций по кругу
  async function testScene() {
    await E.init();
    for (let i = 0; i < 8; i++) {
      const pan = Math.sin((i / 8) * Math.PI * 2);
      E.playTone({ freq: 1500, duration: 0.5, gainDb: -18, pan, left: true, right: true });
      await sleep(600);
    }
    saveResult('scene', 'Сцена', 'Пройдено 8 позиций по кругу', 'ok', 100,
      'Источник должен плавно перемещаться по кругу без «скачков» и с сохранением высоты тона.');
  }

  // ------------------------------------------------------------------
  // 6. МИКРОФОН
  // ------------------------------------------------------------------

  let _vuUnsub = null;
  async function startVU() {
    await E.init();
    if (!E.micStream) await E.startMic();
    if (_vuUnsub) _vuUnsub();
    _vuUnsub = E.onMicFrame((frame) => {
      global.dispatchEvent(new CustomEvent('mic:frame', { detail: frame }));
    });
  }
  function stopVU() {
    if (_vuUnsub) { _vuUnsub(); _vuUnsub = null; }
  }

  async function testRecordAndPlay() {
    await E.init();
    if (!E.micStream) await E.startMic();
    const { buffer, blob } = await E.recordMic(3);
    // Проигрываем обратно
    const src = E.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(E.master);
    src.start();
    _recordedBuffer = { buffer, blob };
    saveResult('mic-rec', 'Запись', 'Записано и воспроизведено 3 с', 'ok', 100,
      'Если звук при воспроизведении глухой/тихий — проблема с уровнем или микрофоном.');
    return _recordedBuffer;
  }
  let _recordedBuffer = null;
  function downloadRecording() {
    if (!_recordedBuffer) return;
    const wav = E.bufferToWavBlob(_recordedBuffer.buffer);
    const url = URL.createObjectURL(wav);
    const a = document.createElement('a');
    a.href = url; a.download = 'mic-recording.wav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function restartMicConstraints({ echoCancellation, noiseSuppression, autoGainControl }) {
    await E.init();
    await E.stopMic();
    await E.startMic({ echoCancellation, noiseSuppression, autoGainControl });
    saveResult('mic-suppression', 'Настройки подавления',
      `EC: ${echoCancellation}, NS: ${noiseSuppression}, AGC: ${autoGainControl}`,
      'ok', null,
      'Включённый AGC может сглаживать динамику. Для измерений лучше отключить все три опции.');
  }

  async function testMicRTT() {
    const ms = await measureRoundTrip();
    if (ms == null) {
      saveResult('mic-rtt', 'Round-trip', 'Не удалось измерить', 'info', null,
        'Возможно, уровень в микрофоне слишком низкий.');
      return;
    }
    const verdict = ms < 30 ? 'ok' : ms < 100 ? 'info' : 'warn';
    saveResult('mic-rtt', 'Round-trip latency',
      `${ms.toFixed(1)} мс`, verdict,
      clamp(100 - ms / 5, 0, 100),
      'Типичные значения: <10 мс — ASIO/CoreAudio, 20–50 мс — WASAPI shared, >100 мс — Bluetooth.');
  }

  async function testEcho() {
    await E.init();
    if (!E.micStream) await E.startMic();

    const recPromise = E.recordMic(2.5);
    await sleep(300);
    E.playImpulse({ gainDb: -6, left: true, right: true });

    const { buffer } = await recPromise;
    const data = buffer.getChannelData(0);

    // Считаем энергию после первого пика
    const threshold = 0.02;
    let firstPeak = -1;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > threshold) { firstPeak = i; break; }
    }
    if (firstPeak < 0) {
      saveResult('mic-echo', 'Эхо', 'Прямой сигнал не обнаружен', 'info', null, '');
      return;
    }
    const tailStart = firstPeak + Math.floor(E.ctx.sampleRate * 0.05);
    let tailEnergy = 0;
    for (let i = tailStart; i < data.length; i++) tailEnergy += data[i] * data[i];
    tailEnergy = Math.sqrt(tailEnergy / Math.max(1, data.length - tailStart));
    const directRms = Math.sqrt(
      data.slice(Math.max(0, firstPeak - 100), firstPeak + 500)
        .reduce((a, b) => a + b * b, 0) / 600
    );
    const tailDb = gainToDb(tailEnergy);
    const ratio = tailEnergy / (directRms || 1e-9);

    const verdict = tailDb < -60 ? 'ok' : tailDb < -45 ? 'info' : 'warn';
    saveResult('mic-echo', 'Эхо/отражения',
      `Уровень хвоста: ${tailDb.toFixed(1)} дБFS, отношение хвост/прямой ≈ ${(ratio).toFixed(3)}`,
      verdict, null,
      'Значительный «хвост» указывает на реверберацию помещения или наличие эхо-подавления.');
  }

  // ------------------------------------------------------------------
  // 7. ИЗМЕРЕНИЯ
  // ------------------------------------------------------------------

  // Снимаем постоянный поток спектра — app.js рисует
  let _specUnsub = null;
  async function startSpectrum() {
    await E.init();
    if (!E.micStream) await E.startMic();
    if (_specUnsub) return;
    _specUnsub = E.onMicFrame((frame) => {
      global.dispatchEvent(new CustomEvent('mic:spectrum', { detail: frame }));
    });
  }
  function stopSpectrum() {
    if (_specUnsub) { _specUnsub(); _specUnsub = null; }
  }

  // SPL: относительный уровень
  async function startSPL() {
    await E.init();
    if (!E.micStream) await E.startMic();
    const unsub = E.onMicFrame((frame) => {
      global.dispatchEvent(new CustomEvent('spl:frame', {
        detail: {
          db: frame.rmsDb,
          relDb: E.refDb != null ? frame.rmsDb - E.refDb : null
        }
      }));
    });
    _splUnsub = unsub;
  }
  let _splUnsub = null;
  function stopSPL() { if (_splUnsub) { _splUnsub(); _splUnsub = null; } }

  // Калибровка 0 дБ
  async function calibrateSPL() {
    await E.init();
    if (!E.micStream) await E.startMic();
    const frame = await E.captureSpectrum({ seconds: 0.5 });
    E.refDb = levelDb(frame.time);
    saveResult('spl-cal', 'Калибровка 0 дБ',
      `Опорный уровень: ${E.refDb.toFixed(1)} дБFS = 0 dBSPL(rel)`,
      'ok', 100,
      'Все дальнейшие SPL-измерения будут относительно этой точки.');
  }

  // Noise floor
  async function testNoiseFloor() {
    await E.init();
    if (!E.micStream) await E.startMic();
    const frames = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) {
      const f = await E.captureSpectrum({ seconds: 0.1 });
      frames.push(levelDb(f.time));
      await sleep(80);
    }
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const min = Math.min(...frames);
    const verdict = avg < -70 ? 'ok' : avg < -55 ? 'info' : 'warn';
    saveResult('nfloor', 'Noise floor',
      `Средний: ${avg.toFixed(1)} дБFS, минимум: ${min.toFixed(1)} дБFS`,
      verdict, null,
      'Значения > -50 дБFS обычно означают активные источники шума: кондиционер, компьютер, USB-фон.');
  }

  // Тест «возраста слуха»: воспроизводим тона и запоминаем, до какой частоты пользователь слышит
  async function playHearingTone(freq) {
    await E.init();
    E.playTone({ freq, duration: 1.5, gainDb: -20, type: 'sine' });
    await sleep(1600);
  }
  function markHearingThreshold(freq) {
    const age = { 8000: '~60+', 10000: '~50', 12000: '~40', 14000: '~30', 16000: '~25', 18000: '~20', 20000: '<20' };
    saveResult('hearing', 'Порог слышимости',
      `Верхняя слышимая частота: ${(freq / 1000).toFixed(1)} кГц (типично для возраста ${age[freq] || '—'})`,
      'ok', null,
      'Порог сильно зависит от громкости воспроизведения и качества наушников. Ориентировочный тест.');
  }

  // Динамический диапазон
  async function testDynRange() {
    await E.init();
    if (!E.micStream) await E.startMic();

    // Тихий сигнал
    E.playTone({ freq: 1000, duration: 1, gainDb: -60, left: true, right: true });
    await sleep(500);
    const low = levelDb((await E.captureSpectrum({ seconds: 0.3 })).time);
    await sleep(600);

    // Громкий сигнал
    E.playTone({ freq: 1000, duration: 1, gainDb: -6, left: true, right: true });
    await sleep(500);
    const high = levelDb((await E.captureSpectrum({ seconds: 0.3 })).time);
    await sleep(600);

    const diff = high - low;
    const verdict = diff > 40 ? 'ok' : diff > 25 ? 'info' : 'warn';
    saveResult('dyn-range', 'Динамический диапазон',
      `Разница тихий/громкий: ${diff.toFixed(1)} дБ`,
      verdict, null,
      'Не менее 40 дБ — хороший показатель. Меньше 25 дБ — возможен AGC в тракте.');
  }

  // Wow & flutter: подаём опорный тон 3150 Гц, анализируем девиацию
  async function testWowFlutter() {
    await E.init();
    if (!E.micStream) await E.startMic();
    const tone = E.startTone({ freq: 3150, type: 'sine', gainDb: -15, left: true, right: true });
    const samples = [];
    const t0 = performance.now();
    const timer = setInterval(async () => {
      const f = await E.captureSpectrum({ seconds: 0.05 });
      // Оцениваем доминирующую частоту около 3150 Гц
      const { mag, N } = amplitudeSpectrum(f.time);
      const binHz = E.ctx.sampleRate / N;
      const c = Math.round(3150 / binHz);
      let best = 0, bestI = c;
      for (let i = Math.max(1, c - 30); i <= Math.min(mag.length - 1, c + 30); i++) {
        if (mag[i] > best) { best = mag[i]; bestI = i; }
      }
      samples.push(bestI * binHz);
    }, 100);

    await sleep(10000);
    clearInterval(timer);
    tone.stop();

    if (samples.length < 10) {
      saveResult('wow', 'Wow & Flutter', 'Недостаточно данных', 'info', null, '');
      return;
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const dev = samples.map((s) => s - mean);
    const rmsDev = Math.sqrt(dev.reduce((a, b) => a + b * b, 0) / dev.length);
    const pct = (rmsDev / mean) * 100;
    const verdict = pct < 0.1 ? 'ok' : pct < 0.3 ? 'info' : 'warn';
    saveResult('wow', 'Wow & Flutter',
      `Девиация ${pct.toFixed(3)} % (${rmsDev.toFixed(2)} Гц)`,
      verdict, null,
      '<0.1 % — отличный показатель. >0.3 % — заметное «плавание» высоты тона.');
  }

  // ------------------------------------------------------------------
  // 8. ИНСТРУМЕНТЫ
  // ------------------------------------------------------------------

  async function playDTMF(digit) {
    await E.init();
    E.playDTMF(digit, { gainDb: -15, duration: 0.4 });
  }

  let _noiseHandle = null;
  async function startNoise(type) {
    await E.init();
    stopNoise();
    _noiseHandle = E.startNoise({ type, gainDb: -22, left: true, right: true });
  }
  function stopNoise() {
    if (_noiseHandle) { _noiseHandle.stop(); _noiseHandle = null; }
  }

  // ------------------------------------------------------------------
  // 9. ОТЧЁТЫ
  // ------------------------------------------------------------------

  function computeOverallScore() {
    const vals = Object.values(results).filter((r) => r.score != null);
    if (!vals.length) return null;
    return Math.round(vals.reduce((a, r) => a + r.score, 0) / vals.length);
  }

  function buildReport() {
    const score = computeOverallScore();
    const problems = Object.entries(results)
      .filter(([, r]) => r.verdict === 'bad' || r.verdict === 'warn')
      .map(([id, r]) => ({ id, label: r.label, value: r.value, verdict: r.verdict, note: r.note }));

    const recommendations = [];
    if (problems.some((p) => p.id === 'hp-thd')) recommendations.push('Проверьте тракт на предмет искажений: возможно, включён AGC или уровень перегружен.');
    if (problems.some((p) => p.id === 'nfloor')) recommendations.push('Устраните источники шума: помехи по питанию, работу вентиляторов, ЭМ-фон.');
    if (problems.some((p) => p.id === 'crosstalk')) recommendations.push('Проверьте подключение — возможно, каналы перепутаны или кабель повреждён.');
    if (problems.some((p) => p.id === 'dead-zones')) recommendations.push('Обнаружены провалы АЧХ — проверьте расположение микрофона/колонок и акустику помещения.');

    return {
      ts: new Date().toISOString(),
      ua: navigator.userAgent,
      info: E.info(),
      score,
      totalTests: Object.keys(results).length,
      problems,
      recommendations,
      results: { ...results }
    };
  }

  // История
  const HISTORY_KEY = 'audio-diagnostics-history-v1';
  function saveToHistory(report) {
    try {
      const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      arr.unshift({ ts: report.ts, score: report.score, ua: report.ua });
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, 20)));
    } catch (_) {}
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (_) { return []; }
  }
  function clearHistory() { localStorage.removeItem(HISTORY_KEY); }

  function downloadReportJSON(report) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audio-report-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function shareReport(report) {
    // Упаковываем отчёт в base64 и формируем ссылку с #report=...
    const packed = btoa(unescape(encodeURIComponent(JSON.stringify({
      score: report.score,
      problems: report.problems,
      totalTests: report.totalTests,
      ts: report.ts
    }))));
    const url = location.origin + location.pathname + '#report=' + packed;
    return url;
  }

  /* ------------------------------------------------------------------ */
  /* Экспорт                                                            */
  /* ------------------------------------------------------------------ */
  global.AudioTests = {
    // channels
    testChannel, startPingPong, stopPingPong, testPanSweep,
    testCrosstalk, testBtLatency,
    // frequency
    startManualTone, stopManualTone, updateManualTone,
    sweepFull, sweepBass, sweepSub, playHighTone,
    testDeadZones, testResonances,
    // phase
    testPhase, testPolarity, testHeadphonePhase,
    // headphones
    testHeadphoneFR, testTHD, testCrackle,
    startLoudTest, stopLoudTest, markLoud,
    testHeadphoneNoise,
    // speakers
    testSurround, testCrossover, testScene,
    // mic
    startVU, stopVU, testRecordAndPlay, downloadRecording,
    restartMicConstraints, testMicRTT, testEcho,
    // measure
    startSpectrum, stopSpectrum, startSPL, stopSPL,
    calibrateSPL, testNoiseFloor, playHearingTone, markHearingThreshold,
    testDynRange, testWowFlutter,
    // tools
    playDTMF, startNoise, stopNoise,
    // reports
    buildReport, saveToHistory, loadHistory, clearHistory,
    downloadReportJSON, shareReport,
    // utils
    results, measureRoundTrip
  };

})(window);