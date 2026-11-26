/* RH AI DJ Lab · independent Transition Planner.
   Pure planning: analysis in → Transition Plan with candidate points and automation out.
   No audio nodes, no timers, no UI. */
(function () {
  'use strict';
  const CAMELOT = ['8B','3B','10B','5B','12B','7B','2B','9B','4B','11B','6B','1B'];
  const N = 129;

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
  function beatOf(a) { return 60 / Math.max(60, Number(a && a.bpm) || 120); }
  function keyDistance(a, b) {
    const pa = String(a || '').match(/^(\d+)([AB])$/);
    const pb = String(b || '').match(/^(\d+)([AB])$/);
    if (!pa || !pb) return 3;
    const diff = Math.abs(Number(pa[1]) - Number(pb[1]));
    return Math.min(diff, 12 - diff) + (pa[2] === pb[2] ? 0 : 1);
  }
  function nextInOrder(library, current) {
    if (!library || !library.length) return null;
    const index = library.findIndex((t) => t.id === current.id);
    return library[index < 0 ? 0 : (index + 1) % library.length];
  }
  function scorePair(a, b) {
    if (!a || !b) return -999;
    const bpmDelta = Math.abs((b.bpm || 0) - (a.bpm || 0)) / Math.max(1, a.bpm || 1);
    return 5 - bpmDelta * 30 - keyDistance(a.key, b.key) * 0.9
      - Math.abs((b.energy || 0) - (a.energy || 0)) * 2
      - Math.min(a.vocalRisk || 0, b.vocalRisk || 0);
  }
  function uniqueGrid(values, step, min, max) {
    const out = [];
    for (const value of values || []) {
      if (!Number.isFinite(value)) continue;
      const aligned = Math.round(value / step) * step;
      if (aligned >= min && aligned <= max && !out.some((x) => Math.abs(x - aligned) < 0.05)) out.push(aligned);
    }
    return out;
  }
  function candidatesForExit(a) {
    const beat = beatOf(a); const phrase = beat * 16;
    const min = Math.max(4, a.duration * 0.30); const max = a.duration - 8;
    const values = [];
    for (const s of a.sections || []) {
      if (s.start >= min && s.start <= max) values.push(s.start);
      if (s.end >= min && s.end <= max) values.push(s.end);
    }
    for (let t = min; t <= max; t += phrase) values.push(t);
    if (!values.length) values.push(clamp(a.duration - 16, min, max));
    return uniqueGrid(values, beat * 4, min, max);
  }
  function candidatesForEntry(b) {
    const beat = beatOf(b); const phrase = beat * 16;
    const max = b.duration - 8;
    const values = [];
    for (const s of b.sections || []) {
      if (s.start > 4 && s.start <= max) values.push(s.start);
      if (s.end > 4 && s.end <= max && s.kind !== 'outro') values.push(s.end);
    }
    if (b.introEnd > 4 && b.introEnd < max) values.push(b.introEnd);
    for (let t = Math.min(16, max); t <= max; t += phrase) values.push(t);
    if (!values.length) values.push(0);
    return uniqueGrid(values, beat * 4, 0, max);
  }
  function automationFor(plan, a, b) {
    const growIn = []; const growOut = []; const lowIn = []; const lowOut = [];
    const midIn = []; const midOut = []; const highIn = []; const highOut = [];
    const out = plan.outgoingTrack; const inc = plan.incomingTrack;
    const vocalConflict = (a.vocalRisk || 0) + (b.vocalRisk || 0) > 1.25;
    for (let i = 0; i < N; i += 1) {
      const x = i / (N - 1);
      const inGain = Math.sin(x * Math.PI / 2);
      const outGain = Math.cos(x * Math.PI / 2);
      growIn.push(inGain); growOut.push(outGain);
      const smooth = x * x * (3 - 2 * x);
      const swap = clamp((x - 0.42) / 0.18, 0, 1);
      const s = swap * swap * (3 - 2 * swap);
      lowIn.push(-18 + 18 * s);
      lowOut.push(-2 - 22 * s);
      midIn.push(-8 + 8 * smooth);
      midOut.push(0 - 8 * smooth);
      highIn.push(-5 + 5 * smooth);
      highOut.push(0 - 5 * smooth);
    }
    if (vocalConflict) for (let i = 0; i < N; i += 1) midOut[i] -= 4 * Math.sin((i / (N - 1)) * Math.PI / 2);
    return {
      outgoingVolume: growOut,
      incomingVolume: growIn,
      lowEQ: { out: lowOut, in: lowIn },
      midEQ: { out: midOut, in: midIn },
      highEQ: { out: highOut, in: highIn },
      filters: plan.strategy === 'filter_blend'
        ? { outgoing: { type: 'lowpass', from: 18000, to: 1200 }, incoming: { type: 'highpass', from: 260, to: 35 } }
        : null,
      effects: [],
    };
  }
  function plan(outgoing, incoming) {
    if (!outgoing || !incoming) return null;
    const beat = beatOf(outgoing);
    const base = scorePair(outgoing, incoming);
    const exits = candidatesForExit(outgoing);
    const entries = candidatesForEntry(incoming);
    let best = null;
    const bpmDiff = Math.abs((incoming.bpm || 0) - (outgoing.bpm || 0)) / Math.max(1, outgoing.bpm || 1);
    for (const startA of exits) {
      for (const startB of entries) {
        if (startA >= outgoing.duration - 2 || startB >= incoming.duration - 2) continue;
        const vocalRisk = Math.max(outgoing.vocalRisk || 0, incoming.vocalRisk || 0);
        let bars = bpmDiff < 0.045 && vocalRisk < 0.48 ? 16 : bpmDiff < 0.09 ? 8 : 4;
        let duration = bars * 4 * beat;
        if (startA + duration > outgoing.duration - 0.5) { bars = 4; duration = bars * 4 * beat; }
        if (startA + duration > outgoing.duration - 0.2) continue;
        const secA = (outgoing.sections || []).find((s) => startA >= s.start - 1 && startA <= s.end + 1);
        const secB = (incoming.sections || []).find((s) => startB >= s.start - 1 && startB <= s.end + 1);
        const eA = secA ? secA.energy : outgoing.energy || 0.5;
        const eB = secB ? secB.energy : incoming.energy || 0.5;
        const latePenalty = Math.max(0, startA - (outgoing.duration - 45)) / 12;
        const lateEntryPenalty = Math.max(0, startB - incoming.duration * 0.45) / 10;
        const entryBonus = secB && (secB.kind === 'drop' || secB.kind === 'verse') ? 0.35 : 0;
        const score = base + 1.8 * eA + 1.3 * eB - Math.abs(eA - eB) * 1.8 - latePenalty - lateEntryPenalty + entryBonus;
        const strategy = bpmDiff > 0.12 ? 'filter_blend'
          : vocalRisk > 0.65 ? 'vocal_handoff'
            : keyDistance(outgoing.key, incoming.key) <= 1 ? 'phrase_aware_bass_swap' : 'phrase_aware_blend';
        const candidate = {
          outgoingTrack: outgoing.id || outgoing.trackId,
          incomingTrack: incoming.id || incoming.trackId,
          transitionStartA: startA,
          transitionStartB: startB,
          transitionDuration: duration,
          bpmA: outgoing.bpm,
          bpmB: incoming.bpm,
          targetBpm: outgoing.bpm,
          phraseAligned: true,
          beatAligned: true,
          bars,
          strategy,
          score,
        };
        candidate.automation = automationFor(candidate, outgoing, incoming);
        if (!best || score > best.score) best = candidate;
      }
    }
    if (!best) {
      const startA = Math.max(outgoing.duration * 0.65, outgoing.duration - 20);
      const fallback = {
        outgoingTrack: outgoing.id || outgoing.trackId,
        incomingTrack: incoming.id || incoming.trackId,
        transitionStartA: startA,
        transitionStartB: 0,
        transitionDuration: beat * 32,
        bpmA: outgoing.bpm,
        bpmB: incoming.bpm,
        targetBpm: outgoing.bpm,
        phraseAligned: false,
        beatAligned: false,
        bars: 8,
        strategy: 'safe_fallback',
        score: base,
      };
      fallback.automation = automationFor(fallback, outgoing, incoming);
      return fallback;
    }
    return best;
  }

  window.RH_DJ_PLANNER = { plan, nextInOrder, keyDistance, scorePair, CAMELOT, N };
})();
