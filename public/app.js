(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const engine = new window.RH_DJ.Engine({
    onStatus(info) {
      $('enginePill').textContent = (info.phase || 'idle').toUpperCase();
      const labels = { loading:'Загрузка', analyzed:'Анализ готов', playing:'Играет', paused:'Пауза', mixing:'Переход', prepared:'Следующий готов', ready_next:'Следующий готов', mix_on:'AutoMix включён', mix_off:'Mix выключен' };
      $('mixState').textContent = labels[info.phase] || info.phase || '—';
      $('mixBtn').classList.toggle('on', engine.mix);
    },
    onTrack(track) { renderNow(track); },
  });

  let tracks = [];
  let current = null;
  let seekDirty = false;

  function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmt(s) { const n = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }
  function baseName(name) { return String(name || 'Трек').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim(); }

  function renderPlaylist() {
    $('playlistCount').textContent = tracks.length + ' треков';
    if (!tracks.length) { $('playlist').innerHTML = '<div class="empty">Пока пусто. Загрузи минимум два трека.</div>'; return; }
    $('playlist').innerHTML = tracks.map((t, i) => `<div class="track-row${current && current.id === t.id ? ' is-current' : ''}">
      <span class="order">${i + 1}</span>
      <div class="cover">${t.cover ? `<img src="${esc(t.cover)}" alt="">` : '♪'}</div>
      <div class="meta"><div class="title">${esc(t.title)}</div><div class="sub">${fmt(t.duration)} · ${esc(t.state || 'готов')}</div></div>
      <button class="mini" type="button" data-up="${i}" title="Выше">↑</button>
      <button class="mini" type="button" data-down="${i}" title="Ниже">↓</button>
      <button class="lib-play" type="button" data-play="${t.id}">▶</button>
      <button class="mini" type="button" data-del="${t.id}" title="Удалить">×</button>
    </div>`).join('');
  }

  async function addFiles(files) {
    for (const file of Array.from(files || [])) {
      if (!file.type.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)) continue;
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.src = url;
      await new Promise((resolve) => {
        const done = () => resolve();
        audio.addEventListener('loadedmetadata', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        setTimeout(done, 3500);
      });
      tracks.push({
        id: 'local:' + file.name + ':' + file.size + ':' + file.lastModified,
        title: baseName(file.name),
        artist: 'Локальный файл',
        duration: Number(audio.duration) || 0,
        url,
        file,
        state: 'готов',
      });
    }
    engine.setLibrary(tracks);
    renderPlaylist();
  }

  function renderNow(track) {
    current = track;
    $('trackTitle').textContent = track.title;
    $('trackArtist').textContent = track.artist;
    $('cover').innerHTML = track.cover ? `<img src="${esc(track.cover)}" alt="">` : '♪';
    renderPlaylist();
  }

  function updateAnalysis() {
    const info = engine.getMixInfo();
    const a = engine.track && engine.analysis.get(engine.track.id);
    const b = info && info.next && engine.analysis.get(info.next.id);
    $('nowTrack').textContent = engine.track ? engine.track.title : '—';
    $('nextTrack').textContent = info && info.next ? info.next.title : '—';
    $('bpmInfo').textContent = a ? `${Math.round(a.bpm)} → ${b ? Math.round(b.bpm) : '…'}` : '—';
    $('strategyInfo').textContent = info ? (info.strategy || '—') : '—';
    $('pointsInfo').textContent = info ? `OUT ${fmt(info.at)} · IN ${fmt(info.entryAt)} · ${Math.round(info.durationSec || 0)}s` : '—';
    const marker = $('mixMarker');
    if (info && engine.duration()) {
      marker.hidden = false;
      marker.style.left = Math.min(100, info.at / engine.duration() * 100) + '%';
      $('mixPointLabel').textContent = `MIX ${fmt(info.at)} → ${info.next ? info.next.title : '—'}`;
    } else { marker.hidden = true; $('mixPointLabel').textContent = ''; }
    $('deckInfo').textContent = a && info ? `${info.strategy} · OUT ${fmt(info.at)} · IN ${fmt(info.entryAt)}` : (a ? 'анализ структуры…' : 'анализ структуры…');
  }

  function updateTimeline() {
    if (!engine.decks) return;
    const d = engine.duration(); const p = engine.position();
    const pct = d ? Math.min(100, p / d * 100) : 0;
    $('currentTime').textContent = fmt(p); $('durationTime').textContent = fmt(d);
    if (!seekDirty) { $('seekBar').value = String(Math.round(pct * 10)); $('seekBar').style.setProperty('--played', pct + '%'); }
    $('playBtn').textContent = engine.playing ? '❚❚' : '▶';
    $('mixBtn').classList.toggle('on', engine.mix);
    updateAnalysis();
  }

  $('fileInput').addEventListener('change', async (e) => { await addFiles(e.target.files); e.target.value = ''; });
  const drop = document.querySelector('.dropzone');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('is-over'); await addFiles(e.dataTransfer.files); });

  document.addEventListener('click', async (e) => {
    const play = e.target.closest('[data-play]');
    if (play) { const track = tracks.find((t) => t.id === play.dataset.play); if (track) { try { await engine.playTrack(track); renderNow(track); } catch { $('mixState').textContent = 'Файл не читается'; } } return; }
    const del = e.target.closest('[data-del]');
    if (del) { tracks = tracks.filter((t) => t.id !== del.dataset.del); engine.setLibrary(tracks); renderPlaylist(); return; }
    const up = e.target.closest('[data-up]');
    if (up) { const i = Number(up.dataset.up); if (i > 0) { [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; engine.setLibrary(tracks); renderPlaylist(); } return; }
    const down = e.target.closest('[data-down]');
    if (down) { const i = Number(down.dataset.down); if (i < tracks.length - 1) { [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; engine.setLibrary(tracks); renderPlaylist(); } return; }
  });

  $('clearBtn').addEventListener('click', () => { tracks.forEach((t) => URL.revokeObjectURL(t.url)); tracks = []; engine.setLibrary(tracks); engine.pause(); renderPlaylist(); });
  $('playBtn').addEventListener('click', async () => { try { if (engine.playing) { engine.pause(); } else if (engine.decks) { await engine.resume(); } else if (tracks[0]) { await engine.playTrack(tracks[0]); renderNow(tracks[0]); } } catch { $('mixState').textContent = 'Не удалось включить'; } });
  $('nextBtn').addEventListener('click', async () => { if (!current) return; const i = tracks.findIndex((t) => t.id === current.id); const next = tracks[(i + 1) % tracks.length]; if (next) { await engine.playTrack(next); renderNow(next); } });
  $('mixBtn').addEventListener('click', () => engine.toggle());
  $('seekBar').addEventListener('input', () => { seekDirty = true; const d = engine.duration(); const value = Number($('seekBar').value) / 1000; $('seekBar').style.setProperty('--played', value * 100 + '%'); $('currentTime').textContent = fmt(d * value); });
  $('seekBar').addEventListener('change', () => { const d = engine.duration(); engine.seek(d * Number($('seekBar').value) / 1000); seekDirty = false; updateTimeline(); });
  setInterval(updateTimeline, 500);
  renderPlaylist();
})();
