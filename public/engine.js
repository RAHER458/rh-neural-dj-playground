/* RH AI DJ Lab · independent dual-deck engine. No RH-MUSIC code. */
(function () {
  'use strict';
  const API = '';
  const sourceUrl = (track) => track.url || (API + '/api/stream/' + track.source + '/' + encodeURIComponent(track.sourceId));
  const CAMELOT = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B'];
  const P = window.RH_DJ_PLANNER;
  const ANALYSIS_CACHE = 'rh_dj_analysis_v2';
  const readCache = () => { try { return JSON.parse(localStorage.getItem(ANALYSIS_CACHE) || '{}') || {}; } catch { return {}; } };
  const writeCache = (cache) => { try { localStorage.setItem(ANALYSIS_CACHE, JSON.stringify(cache)); } catch { /* quota */ } };

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function rms(data) { let s = 0; for (let i = 0; i < data.length; i += 1) s += data[i] * data[i]; return Math.sqrt(s / Math.max(1, data.length)); }

  function analyzeBuffer(buffer) {
    const sampleRate = buffer.sampleRate;
    const channels = Math.min(2, buffer.numberOfChannels);
    const src = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(sampleRate / 11025));
    const mono = [];
    for (let i = 0; i < src.length; i += step) {
      let v = src[i];
      for (let c = 1; c < channels; c += 1) v += buffer.getChannelData(c)[i];
      mono.push(v / channels);
    }
    const sr = sampleRate / step;
    const frame = Math.max(64, Math.floor(sr * 0.046));
    const hop = Math.max(32, Math.floor(sr * 0.023));
    const energies = [];
    for (let i = 0; i + frame < mono.length; i += hop) {
      let e = 0;
      for (let j = 0; j < frame; j += 1) e += mono[i + j] * mono[i + j];
      energies.push(Math.sqrt(e / frame));
    }
    const onset = energies.map((v, i) => Math.max(0, v - (energies[i - 1] || 0)));
    let beatOffset = 0; let peak = 0;
    for (let i = 0; i < Math.min(onset.length, 220); i += 1) {
      if (onset[i] > peak) { peak = onset[i]; beatOffset = i * hop / sr; }
    }
    // Autocorrelation of the onset envelope for BPM (60–200).
    let best = { bpm: 0, score: 0 };
    const minLag = Math.floor(sr / hop * 60 / 200);
    const maxLag = Math.floor(sr / hop * 60 / 60);
    const mean = onset.reduce((a, b) => a + b, 0) / Math.max(1, onset.length);
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let sum = 0; let count = 0;
      for (let i = 0; i + lag < onset.length; i += 1) { sum += (onset[i] - mean) * (onset[i + lag] - mean); count += 1; }
      const score = count ? sum / count : 0;
      if (score > best.score) best = { bpm: 60 * (sr / hop) / lag, score };
    }
    let bpm = best.bpm;
    while (bpm && bpm < 70) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    // Simple chroma via zero-crossing-ish spectral proxy: use low/mid/high band ratios.
    let low = 0; let mid = 0; let high = 0;
    for (let i = 0; i + frame < mono.length; i += hop * 4) {
      for (let j = 0; j < frame; j += 1) {
        const v = mono[i + j];
        const f = Math.abs(v);
        if (f < 0.02) high += f; else if (f < 0.12) mid += f; else low += f;
      }
    }
    const total = low + mid + high || 1;
    const energy = clamp(rms(mono) * 5.5 + (energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length)) * 2, 0, 1);
    const vocal = clamp(mid / total * 1.2 + (1 - high / total) * 0.2, 0, 1);
    const keyIndex = Math.abs(Math.round((low - high) / total * 12)) % 12;
    const duration = buffer.duration;
    const introEnd = Math.min(duration * 0.18, 24);
    const outroStart = Math.max(duration - Math.min(duration * 0.18, 32), duration * 0.65);
    const beatSec = 60 / Math.max(60, bpm || 120);
    const sections = [];
    const block = Math.max(8, beatSec * 32);
    const frameRate = sr / hop;
    const blockEnergies = [];
    for (let start = 0; start < duration; start += block) {
      const end = Math.min(duration, start + block);
      const from = Math.max(0, Math.floor(start * frameRate));
      const to = Math.min(energies.length, Math.ceil(end * frameRate));
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += energies[i] || 0;
      const avg = to > from ? sum / (to - from) : 0;
      blockEnergies.push(avg);
      const kind = start < duration * 0.12 ? 'intro'
        : end > duration * 0.88 ? 'outro'
          : avg < 0.025 ? 'breakdown'
            : avg > 0.07 ? 'drop' : 'verse';
      sections.push({ start, end, energy: avg, kind });
    }
    const maxBlock = Math.max(0.0001, ...blockEnergies);
    for (const section of sections) section.energy = clamp(section.energy / maxBlock, 0.15, 1);
    return {
      bpm: Math.round(bpm * 10) / 10,
      bpmConfidence: clamp(best.score * 18, 0, 1),
      key: CAMELOT[keyIndex],
      keyConfidence: 0.45,
      energy,
      vocalRisk: vocal,
      duration,
      introEnd,
      outroStart,
      beat: 60 / Math.max(60, bpm || 120),
      phrase: 32 * (60 / Math.max(60, bpm || 120)),
      beatOffset,
      sections,
      low, mid, high,
    };
  }

  function nextInOrder(library, current) { return P ? P.nextInOrder(library, current) : null; }

  function keyDistance(a, b) { return P ? P.keyDistance(a, b) : 3; }

  function scoreCandidate(current, next) { return P ? P.scorePair(current, next) : -999; }

  function planTransition(a, b) {
    if (!P || !P.plan) return null;
    const plan = P.plan(a, b);
    if (!plan) return null;
    return {
      ...plan,
      exitAt: plan.transitionStartA,
      entryAt: plan.transitionStartB,
      durationSec: plan.transitionDuration,
      next: b,
    };
  }

  class Deck {
    constructor(ctx, master) {
      this.audio = new Audio();
      this.audio.crossOrigin = 'anonymous';
      this.audio.preload = 'auto';
      this.source = ctx.createMediaElementSource(this.audio);
      this.gain = ctx.createGain();
      this.low = ctx.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 180;
      this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = 0.7;
      this.high = ctx.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 6500;
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'allpass'; this.filter.frequency.value = 20000; this.filter.Q.value = 0.7;
      this.source.connect(this.low).connect(this.mid).connect(this.high).connect(this.filter).connect(this.gain).connect(master);
      this.gain.gain.value = 0;
    }
    load(url) {
      return new Promise((resolve, reject) => {
        this.audio.src = url;
        this.audio.load();
        const ok = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(new Error('audio_load_failed')); };
        const cleanup = () => { this.audio.removeEventListener('canplay', ok); this.audio.removeEventListener('error', bad); };
        this.audio.addEventListener('canplay', ok, { once: true });
        this.audio.addEventListener('error', bad, { once: true });
      });
    }
    async play(offset = 0) {
      try { this.audio.currentTime = offset; } catch { /* ignore */ }
      await this.audio.play();
    }
    pause() { this.audio.pause(); }
    setGain(value, time = 0.2) {
      const now = this.gain.context.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), now);
      this.gain.gain.linearRampToValueAtTime(Math.max(0, value), now + time);
    }
    setBass(value) { this.low.gain.setTargetAtTime(value, this.gain.context.currentTime, 0.03); }
    setEq(lowDb, midDb, highDb, seconds = 0.2) {
      const now = this.gain.context.currentTime;
      const ramp = (param, value) => {
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(value, now + Math.max(0.01, seconds));
      };
      ramp(this.low.gain, lowDb);
      ramp(this.mid.gain, midDb);
      ramp(this.high.gain, highDb);
    }
    setFilter(type, frequency, time = 0.2) {
      const now = this.gain.context.currentTime;
      this.filter.type = type;
      this.filter.frequency.cancelScheduledValues(now);
      this.filter.frequency.setValueAtTime(this.filter.frequency.value, now);
      this.filter.frequency.linearRampToValueAtTime(frequency, now + Math.max(0.01, time));
    }
    setRate(value) {
      this.audio.preservesPitch = true;
      this.audio.mozPreservesPitch = true;
      this.audio.webkitPreservesPitch = true;
      this.audio.playbackRate = clamp(Number(value) || 1, 0.9, 1.1);
    }
  }

  class Engine {
    constructor({ onStatus = () => {}, onTrack = () => {} } = {}) {
      this.ctx = null; this.master = null;
      this.decks = null; this.current = 0; this.track = null; this.library = [];
      this.analysis = new Map(); this.playing = false; this.mix = false;
      this.timer = null; this.transitioning = false; this.prepared = null; this.onStatus = onStatus; this.onTrack = onTrack;
    }
    async init() {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      document.addEventListener('pointerdown', () => { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }, { passive: true });
      this.decks = [new Deck(this.ctx, this.master), new Deck(this.ctx, this.master)];
    }
    async analyze(track) {
      if (this.analysis.has(track.id)) return this.analysis.get(track.id);
      const cache = readCache();
      if (cache[track.id] && cache[track.id].bpm) {
        this.analysis.set(track.id, cache[track.id]);
        return cache[track.id];
      }
      const res = await fetch(sourceUrl(track));
      if (!res.ok) throw new Error('stream_unavailable');
      const buf = await res.arrayBuffer();
      const decoded = await this.ctx.decodeAudioData(buf.slice(0));
      const analysis = analyzeBuffer(decoded);
      analysis.trackId = track.id;
      this.analysis.set(track.id, analysis);
      const nextCache = readCache();
      nextCache[track.id] = analysis;
      const ids = Object.keys(nextCache);
      if (ids.length > 80) for (const id of ids.slice(0, ids.length - 80)) delete nextCache[id];
      writeCache(nextCache);
      this.onStatus({ phase: 'analyzed', track });
      return analysis;
    }
    async setLibrary(tracks) { this.library = tracks || []; }
    async playTrack(track, index = 0) {
      await this.init();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      const deck = this.decks[this.current];
      this.track = track;
      this.onStatus({ phase: 'loading', track });
      const url = sourceUrl(track);
      await deck.load(url);
      deck.setGain(1, 0.08);
      deck.setBass(0);
      // Не блокируем UI на play(): iOS может отложить разрешение автоплея.
      deck.play(0).catch(() => { this.playing = false; this.onStatus({ phase: 'paused', track }); });
      this.playing = true;
      this.onTrack(track);
      this.onStatus({ phase: 'playing', track });
      this.prepared = null;
      this.analyze(track).then(() => this.prepareNext()).catch(() => {});
      this.primeCandidates(track).then(() => this.prepareNext()).catch(() => {});
      this.startMonitor();
    }
    async primeCandidates(currentTrack) {
      const next = nextInOrder(this.library, currentTrack);
      if (next && !this.analysis.has(next.id)) {
        try { await this.analyze(next); } catch { /* skip */ }
      }
    }
    async prepareNext() {
      if (!this.track || this.transitioning) return null;
      const currentAnalysis = this.analysis.get(this.track.id);
      if (!currentAnalysis) return null;
      if (this.prepared && this.prepared.forId === this.track.id) return this.prepared;
      // Порядок задаёт пользователь. Движок не ранжирует и не переставляет треки.
      const candidate = nextInOrder(this.library, this.track);
      if (!candidate) return null;
      let best = null; let bestPlan = null;
      try {
        const ca = await this.analyze(candidate);
        best = { track: candidate, analysis: ca };
        bestPlan = planTransition(currentAnalysis, ca);
      } catch { return null; }
      const bestScore = bestPlan ? bestPlan.score : scoreCandidate(currentAnalysis, best.analysis);
      const deckIndex = 1 - this.current;
      const deck = this.decks[deckIndex];
      try {
        await Promise.race([
          deck.load(sourceUrl(best.track)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('preload_timeout')), 12000)),
        ]);
      } catch { return null; }
      this.prepared = { ...best, plan: bestPlan, deckIndex, forId: this.track.id, score: bestScore };
      this.onStatus({ phase: this.mix ? 'prepared' : 'ready_next', next: best.track });
      return this.prepared;
    }
    startMonitor() {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.tick().catch(() => {}), 400);
    }
    async tick() {
      if (!this.mix || !this.playing || this.transitioning) return;
      const deck = this.decks[this.current];
      const track = this.track;
      if (!deck || !track) return;
      const analysis = this.analysis.get(track.id);
      if (!analysis) { this.analyze(track).catch(() => {}); return; }
      const info = this.getMixInfo();
      if (!info) return;
      const position = deck.audio.currentTime || 0;
      if (!this.prepared && position >= Math.max(0, info.at - 60)) this.prepareNext().catch(() => {});
      if (position < info.at) return;
      if (!this.prepared) return;
      await this.transition();
    }
    getMixInfo() {
      if (!this.track) return null;
      const analysis = this.analysis.get(this.track.id);
      if (!analysis) return null;
      const beat = 60 / Math.max(60, analysis.bpm || 120);
      const next = nextInOrder(this.library, this.track);
      let bestPlan = null;
      if (next) {
        const ca = this.analysis.get(next.id);
        if (ca) bestPlan = planTransition(analysis, ca);
      }
      if (!bestPlan) {
        const fallbackAt = Math.max(analysis.duration * 0.65, analysis.duration - 20);
        bestPlan = { exitAt: Math.floor(fallbackAt / (beat * 4)) * beat * 4, entryAt: 0, durationSec: 12, bars: 8, score: 0, strategy: 'safe fallback' };
      }
      return { ...bestPlan, at: bestPlan.exitAt, next: next || bestPlan.next, analysis };
    }
    seek(seconds) {
      if (!this.decks) return false;
      const deck = this.decks[this.current];
      const duration = deck.audio.duration || (this.track && this.track.duration) || 0;
      if (!duration) return false;
      deck.audio.currentTime = clamp(Number(seconds) || 0, 0, Math.max(0, duration - 0.15));
      this.onStatus({ phase: this.playing ? 'playing' : 'paused', track: this.track });
      return true;
    }
    async transition() {
      if (this.transitioning) return;
      this.transitioning = true;
      try {
        const currentTrack = this.track;
        const currentAnalysis = this.analysis.get(currentTrack.id);
        if (!currentAnalysis) { this.transitioning = false; return; }
        let prepared = this.prepared;
        const expected = nextInOrder(this.library, currentTrack);
        if (!prepared || prepared.forId !== currentTrack.id || !expected || prepared.track.id !== expected.id) prepared = await this.prepareNext();
        if (!prepared || prepared.deckIndex !== 1 - this.current) { this.transitioning = false; return; }
        const nextTrack = prepared.track, nextAnalysis = prepared.analysis;
        const nextDeck = this.decks[prepared.deckIndex], oldDeck = this.decks[this.current];
        const plan = prepared.plan || planTransition(currentAnalysis,nextAnalysis);
        this.onStatus({ phase:'mixing', next:nextTrack, strategy:plan.strategy, plan });

        // Match tempo conservatively: extreme tempo shifts degrade the mix and are rejected.
        const bpmA = Math.max(60,currentAnalysis.bpm||120), bpmB = Math.max(60,nextAnalysis.bpm||bpmA);
        const rate = clamp(bpmA/bpmB,0.94,1.06);
        nextDeck.setRate(rate);
        const beat = 60/bpmA;
        const entry = clamp(Number(plan.entryAt)||0,0,Math.max(0,(nextAnalysis.duration||nextDeck.audio.duration||0)-2));
        // Never block the transition on an autoplay promise: Safari may resolve it
        // later, but the EQ/gain schedule must still be committed.
        await Promise.race([
          nextDeck.play(entry).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 700)),
        ]);

        const duration = clamp(plan.durationSec || beat*32, beat*16, beat*64);
        const start = this.ctx.currentTime + 0.12;
        const end = start + duration;
        const applyCurve = (param, values, at, sec) => {
          param.cancelScheduledValues(at);
          try {
            param.setValueAtTime(param.value, at);
            param.setValueCurveAtTime(Float32Array.from(values), at, sec);
          } catch {
            // Safari edge case: fall back to a safe linear ramp, never abort the mix.
            param.cancelScheduledValues(at);
            param.setValueAtTime(values[0], at);
            param.linearRampToValueAtTime(values[values.length - 1], at + sec);
          }
        };
        const curve = applyCurve;
        const auto = plan.automation || {};
        const N = 129, fadeIn = auto.incomingVolume || [], fadeOut = auto.outgoingVolume || [];
        // Equal-power curves come from the planner when available.
        curve(nextDeck.gain.gain, fadeIn.length ? fadeIn : Array.from({length:N},(_,i)=>Math.sin((i/(N-1))*Math.PI/2)), start, duration);
        curve(oldDeck.gain.gain, fadeOut.length ? fadeOut : Array.from({length:N},(_,i)=>Math.cos((i/(N-1))*Math.PI/2)), start, duration);

        const ramp = applyCurve;
        // EQ curves are planned in planner.js, not improvised in the executor.
        const lowIn = (auto.lowEQ && auto.lowEQ.in) || [];
        const lowOut = (auto.lowEQ && auto.lowEQ.out) || [];
        const midIn = (auto.midEQ && auto.midEQ.in) || [];
        const midOut = (auto.midEQ && auto.midEQ.out) || [];
        const highIn = (auto.highEQ && auto.highEQ.in) || [];
        const highOut = (auto.highEQ && auto.highEQ.out) || [];
        if (!lowIn.length || !lowOut.length) throw new Error('planner_automation_missing');
        ramp(nextDeck.low.gain,lowIn,start,duration);
        ramp(oldDeck.low.gain,lowOut,start,duration);
        ramp(nextDeck.mid.gain,midIn,start,duration);
        ramp(oldDeck.mid.gain,midOut,start,duration);
        ramp(nextDeck.high.gain,highIn,start,duration);
        ramp(oldDeck.high.gain,highOut,start,duration);

        // For high vocal-risk pairs, attenuate the mid band more deeply on the outgoing deck.
        // Vocal ducking is included in the planner's mid curve; executor only
        // adds it when the planner had to use a generic curve.
        if (!auto.midEQ && (currentAnalysis.vocalRisk||0)+(nextAnalysis.vocalRisk||0)>1.25) {
          const duck=[]; for(let i=0;i<N;i++){const x=i/(N-1); duck.push(-10*Math.sin(x*Math.PI/2));}
          ramp(oldDeck.mid.gain,duck,start,duration);
        }
        if (auto.filters) {
          nextDeck.setFilter(auto.filters.incoming.type, auto.filters.incoming.from, 0.04);
          oldDeck.setFilter(auto.filters.outgoing.type, auto.filters.outgoing.from, 0.04);
          nextDeck.filter.frequency.setValueAtTime(auto.filters.incoming.from, start);
          nextDeck.filter.frequency.linearRampToValueAtTime(auto.filters.incoming.to, end);
          oldDeck.filter.frequency.setValueAtTime(auto.filters.outgoing.from, start);
          oldDeck.filter.frequency.linearRampToValueAtTime(auto.filters.outgoing.to, end);
        } else {
          nextDeck.setFilter('allpass', 20000, 0.04);
          oldDeck.setFilter('allpass', 20000, 0.04);
        }

        this.current=prepared.deckIndex;
        this.prepared=null;
        this.track=nextTrack;
        this.onTrack(nextTrack);
        this.onStatus({phase:'playing',track:nextTrack,strategy:plan.strategy});
        setTimeout(()=>{
          try { oldDeck.pause(); oldDeck.audio.removeAttribute('src'); oldDeck.audio.load(); oldDeck.setGain(0,0.02); }
          catch{/* cleanup best effort */}
          this.transitioning=false;
          this.primeCandidates(nextTrack).then(()=>this.prepareNext()).catch(()=>{});
        },(duration+0.6)*1000);
      } catch {
        this.transitioning=false;
      }
    }

    setMix(on) {
      this.mix = !!on;
      this.onStatus({ phase: on ? 'mix_on' : 'mix_off' });
      if (on) this.tick().catch(() => {});
    }
    async toggle() {
      if (!this.playing) return;
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
      this.setMix(!this.mix);
    }
    pause() {
      this.decks && this.decks[this.current].pause();
      this.playing = false;
      this.onStatus({ phase: 'paused' });
    }
    async resume() {
      if (!this.decks) return;
      await this.decks[this.current].play();
      this.playing = true;
      this.onStatus({ phase: 'playing', track: this.track });
    }
    setVolume(value) { if (this.master) this.master.gain.value = clamp(value, 0, 1); }
    position() { return this.decks ? this.decks[this.current].audio.currentTime : 0; }
    duration() { return this.decks ? this.decks[this.current].audio.duration || (this.track && this.track.duration) || 0 : 0; }
  }

  window.RH_DJ = { Engine, analyzeBuffer, scoreCandidate, API };
})();
