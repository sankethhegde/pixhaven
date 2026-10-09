// Video player (v2.0 Phase B): the built-in Chromium player (hardware decoding) with our own controls.
// Files it cannot open come through FFmpeg as a stream; then seeking restarts the stream at the new place, so the
// clock is "base + currentTime". Subtitles are drawn by us for the same reason.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { MediaEntry, MediaInfo, PlayerCaps, PlayInfo, PlayStream, SubtitleCue, SubtitleTrack } from '@shared/types';
import { api, errorText, fmtClock } from '../api';
import { Icon } from './ui';
import { Stars, TagEditor } from './Tags';
import * as T from '../tags';

interface Props {
  items: MediaEntry[];
  index: number;
  infos: Map<string, MediaInfo>;
  onIndex: (i: number) => void;
  onClose: () => void;
  playlist?: string;          // v2.1 (PLAY-08): playing a playlist; it goes on to the next video by itself
}

let capsCache: PlayerCaps | null = null;
/** What this computer's built-in player decodes (asked once). */
export function playerCaps(): PlayerCaps {
  if (!capsCache) {
    const v = document.createElement('video');
    capsCache = {
      hevc: v.canPlayType('video/mp4; codecs="hvc1.1.6.L150.90"') !== '' || MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"'),
      av1: v.canPlayType('video/mp4; codecs="av01.0.08M.08"') !== '',
      mkv: v.canPlayType('video/x-matroska; codecs="avc1.640028"') !== '',
    };
  }
  return capsCache;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

export function Player({ items, index, infos, onIndex, onClose, playlist }: Props) {
  const item = items[index];
  const video = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [stream, setStream] = useState<PlayStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [paused, setPaused] = useState(true);
  const [waiting, setWaiting] = useState(true);
  const [volume, setVolume] = useState(() => Number(store.get('player.volume') ?? 1));
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [audio, setAudio] = useState(0);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [subId, setSubId] = useState<string | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [menu, setMenu] = useState<'speed' | 'audio' | 'subs' | null>(null);
  const [resume, setResume] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState<{ x: number; t: number; img?: string } | null>(null);
  // PLAY-07: labels and stars beside the player (remembered open/closed).
  const [tagsOpen, setTagsOpen] = useState(() => store.get('player.tags') === '1');
  T.useTags();
  useEffect(() => { store.set('player.tags', tagsOpen ? '1' : '0'); }, [tagsOpen]);
  useEffect(() => { void T.loadFor([T.ref(item)]); }, [item]);
  const frames = useRef(new Map<number, string>());
  const pendingSeek = useRef<number | null>(null);
  const lastSave = useRef(0);
  const [wantPlay, setWantPlay] = useState(true);
  const [skipping, setSkipping] = useState(false);
  const wantPlayRef = useRef(true);      // what the user asked for, apart from the hidden skip

  const base = stream?.base ?? 0;
  const duration = info?.duration || (video.current && Number.isFinite(video.current.duration) ? video.current.duration : 0);
  const timeNow = () => base + (video.current?.currentTime ?? 0);
  const latest = useRef({ base, duration });
  latest.current = { base, duration };

  // ---- open the file ----
  useEffect(() => {
    let live = true;
    let session: string | null = null;
    setInfo(null); setStream(null); setError(null); setNow(0); setCues([]); setSubId(null); setAudio(0); setResume(null); setWaiting(true);
    frames.current.clear();
    api.player.open(item.path, playerCaps()).then(i => {
      session = i.session;
      if (!live) { void api.player.close(i.session); return; }
      setInfo(i); setSubs(i.subtitles); setResume(i.resumeAt); setWantPlay(i.resumeAt === null);
      setStream({ url: i.url, base: i.base, mode: i.mode, reason: i.reason, encoder: i.encoder });
    }).catch(e => { if (live) setError(errorText(e)); });
    return () => {
      live = false;
      const v = video.current;
      const { base: b, duration: d } = latest.current;
      if (v && session && d) void api.player.position(item.path, b + v.currentTime, d);
      if (session) void api.player.close(session);
      void api.player.playing(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path]);

  // Volume and speed survive stream reloads.
  useEffect(() => { const v = video.current; if (v) { v.volume = volume; v.muted = muted; v.playbackRate = speed; } store.set('player.volume', String(volume)); }, [volume, muted, speed, stream]);

  /** A new source: the <video> is recreated (keyed by URL) and starts by itself when `play`. */
  const loadStream = useCallback((s: PlayStream, play = true, target?: number) => {
    // A copied stream starts on the keyframe before the wanted time: catchUp() skips the gap.
    pendingSeek.current = s.mode !== 'direct' && target !== undefined && target > s.base + 0.1 ? target : null;
    setWantPlay(play || pendingSeek.current !== null);   // the skip needs the video running; it pauses again after
    wantPlayRef.current = play;
    setStream(s);
    setWaiting(true);
    if (!play) setPaused(true);
  }, []);

  const seekTo = useCallback(async (t: number, play?: boolean) => {
    if (!info || !stream) return;
    const target = Math.max(0, Math.min(duration ? duration - 0.25 : t, t));
    setNow(target);
    if (stream.mode === 'direct') { const v = video.current; if (v) { v.currentTime = target; if (play) void v.play().catch(() => {}); } return; }
    // Streams can't seek inside themselves (no byte ranges): FFmpeg restarts at the new place.
    const v = video.current;
    const wasPaused = v?.paused ?? false;
    try { loadStream(await api.player.seek(info.session, target), play ?? !wasPaused, target); } catch (e) { setError(errorText(e)); }
  }, [info, stream, base, duration, loadStream]);

  const togglePlay = useCallback(() => {
    const v = video.current;
    if (!v || resume !== null) return;
    if (v.paused) void v.play().catch(() => {}); else v.pause();
  }, [resume]);

  const onMediaError = async () => {
    if (!info || !stream) return;
    if (stream.mode === 'transcode') { setError('This video could not be played, even after converting it.'); return; }
    try { loadStream(await api.player.seek(info.session, timeNow(), { fallback: true })); } catch (e) { setError(errorText(e)); }
  };

  // Direct play that "works" but shows no picture (a codec the GPU lacks): treat it as an error.
  const onLoaded = () => {
    const v = video.current!;
    if (info && info.width > 0 && v.videoWidth === 0) { void onMediaError(); return; }
    catchUp();
  };
  /**
   * Exact position in a copied stream: it starts on the keyframe before the wanted time and the player can't seek
   * inside a stream, so the gap (usually under 2 s) is played hidden and muted at 16× and the picture shown from there.
   */
  const skipLoop = useRef(false);
  const catchUp = () => {
    const v = video.current;
    if (!v || pendingSeek.current === null || !stream || skipLoop.current) return;
    skipLoop.current = true;
    setSkipping(true);
    // Checked on every frame, slowing down near the target so it stops within a frame or two.
    const step = () => {
      const want = pendingSeek.current;
      if (want === null || video.current !== v) { skipLoop.current = false; return; }
      const remaining = want - stream.base - v.currentTime;
      if (remaining > 0.03) {
        v.muted = true;
        v.playbackRate = Math.min(16, Math.max(1, remaining * 20));
        if (v.paused) void v.play().catch(() => {});
        v.requestVideoFrameCallback(step);
        return;
      }
      pendingSeek.current = null;
      skipLoop.current = false;
      setSkipping(false);
      v.muted = muted;
      v.playbackRate = speed;
      if (!wantPlayRef.current) { v.pause(); setWantPlay(false); }
    };
    step();
  };

  const savePos = useCallback((force = false) => {
    const v = video.current;
    if (!v || !duration || resume !== null) return;
    if (!force && Date.now() - lastSave.current < 5000) return;
    lastSave.current = Date.now();
    void api.player.position(item.path, base + v.currentTime, duration);
  }, [item.path, base, duration, resume]);

  // ---- subtitles ----
  const chooseSubs = async (id: string | null) => {
    setMenu(null); setSubId(id); setCues([]);
    if (!id || !info) return;
    try { setCues(await api.player.subtitles(info.session, id)); } catch (e) { setError(errorText(e)); setSubId(null); }
  };
  const loadSubFile = async () => {
    setMenu(null);
    if (!info) return;
    const r = await api.player.loadSubtitle(info.session);
    if (r) { setSubs(r.tracks); await chooseSubs(r.id); }
  };
  const cue = subId ? cues.find(c => now >= c.start && now <= c.end) : undefined;

  const chooseAudio = async (i: number) => {
    setMenu(null);
    if (!info || i === audio) return;
    setAudio(i);
    const at = timeNow();
    try { loadStream(await api.player.seek(info.session, at, { audio: i }), !(video.current?.paused ?? false), at); } catch (e) { setError(errorText(e)); }
  };

  // ---- next / previous video in the folder ----
  const videoAt = (dir: 1 | -1) => { for (let i = index + dir; i >= 0 && i < items.length; i += dir) if (items[i].kind === 'video') return i; return -1; };
  const prev = videoAt(-1), next = videoAt(1);

  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void shell.current?.requestFullscreen(); };
  useEffect(() => { const f = () => setFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);

  // ---- keyboard (PLAY-04) ----
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      const k = e.key;
      if (k === ' ' || k === 'k') togglePlay();
      else if (k === 'ArrowRight') void seekTo(timeNow() + (e.shiftKey ? 30 : 5));
      else if (k === 'ArrowLeft') void seekTo(timeNow() - (e.shiftKey ? 30 : 5));
      else if (k === 'l') void seekTo(timeNow() + 10);
      else if (k === 'j') void seekTo(timeNow() - 10);
      else if (k === 'ArrowUp') setVolume(v => Math.min(1, +(v + 0.1).toFixed(2)));
      else if (k === 'ArrowDown') setVolume(v => Math.max(0, +(v - 0.1).toFixed(2)));
      else if (k === 'f') toggleFull();
      else if (k === 'm') setMuted(m => !m);
      else if (k === 'n' || k === 'PageDown') { if (next >= 0) onIndex(next); }
      else if (k === 'p' || k === 'PageUp') { if (prev >= 0) onIndex(prev); }
      else if (k === '>' ) setSpeed(s => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)]);
      else if (k === '<') setSpeed(s => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)]);
      else if (k === 'Escape') { if (menu) setMenu(null); else if (document.fullscreenElement) void document.exitFullscreen(); else onClose(); }
      else if (k === 'Home') void seekTo(0);
      else if (/^[0-5]$/.test(k)) void T.setStars([T.ref(item)], Number(k));   // PLAY-04: 1–5 stars, 0 clears
      else if (k === 's' || k === 'S') setTagsOpen(o => !o);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  // Controls and pointer fade out while playing.
  useEffect(() => {
    if (paused || menu || hover || tagsOpen) { setIdle(false); return; }
    const t = setTimeout(() => setIdle(true), 2500);
    return () => clearTimeout(t);
  }, [paused, menu, hover, now]);
  const wake = () => setIdle(false);

  // ---- seek bar preview ----
  const step = Math.max(2, duration / 150);
  const onBarMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const t = (x / r.width) * duration;
    const bucket = Math.round(t / step);
    setHover({ x, t, img: frames.current.get(bucket) });
    if (!frames.current.has(bucket)) {
      frames.current.set(bucket, '');
      void api.player.frame(item.path, bucket * step).then(img => {
        frames.current.set(bucket, img);
        setHover(h => (h && Math.round(h.t / step) === bucket ? { ...h, img } : h));
      }).catch(() => {});
    }
  };
  const onBarClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    void seekTo(((e.clientX - r.left) / r.width) * duration);
  };

  const pct = duration ? Math.min(100, (now / duration) * 100) : 0;
  const thumb = infos.get(item.path)?.thumb;
  const btn = 'h-9 min-w-9 px-2 rounded-lg hover:bg-white/15 flex items-center justify-center gap-1 text-sm';

  return (
    <div ref={shell} className={`fixed inset-0 z-40 bg-black text-white flex flex-col select-none ${idle ? 'cursor-none' : ''}`}
      role="dialog" aria-label={`Player: ${item.name}`} onMouseMove={wake}>
      {/* top bar */}
      <div className={`absolute top-0 inset-x-0 z-10 flex items-center gap-3 px-4 h-14 bg-gradient-to-b from-black/80 to-transparent transition-opacity ${idle ? 'opacity-0' : ''}`}>
        <button onClick={onClose} className={btn} aria-label="Close player"><Icon name="x" /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0"><span className="font-medium truncate" data-testid="player-name">{item.name}</span>
            {(T.tagsOf(item.path)?.stars ?? 0) > 0 && <Stars value={T.tagsOf(item.path)!.stars} size={13} />}</div>
          <div className="text-xs text-white/60 truncate" data-testid="player-mode">
            {playlist && <span className="text-white/90 mr-2" data-testid="player-playlist">▶ {playlist} · {items.slice(0, index + 1).filter(i => i.kind === 'video').length} of {items.filter(i => i.kind === 'video').length}</span>}
            {info ? [info.width ? `${info.width}×${info.height}` : '', info.videoCodec.toUpperCase(), stream?.reason, stream?.encoder ? `(${stream.encoder.replace('h264_', '').replace('qsv', 'Quick Sync').replace('mf', 'Media Foundation')})` : ''].filter(Boolean).join(' · ') : 'Opening…'}
          </div>
        </div>
      </div>

      {/* picture */}
      <div className="flex-1 min-h-0 relative flex items-center justify-center" onClick={() => { if (menu) setMenu(null); else togglePlay(); }} onDoubleClick={toggleFull}>
        {stream && (
          <video ref={video} key={stream.url} src={stream.url} autoPlay={wantPlay && resume === null} className="max-w-full max-h-full w-full h-full object-contain" data-testid="player-video"
            onTimeUpdate={() => { catchUp(); setNow(pendingSeek.current ?? timeNow()); if (pendingSeek.current === null) savePos(); }}
            onPlay={() => { if (pendingSeek.current === null || wantPlayRef.current) setPaused(false); void api.player.playing(true); }}
            onPause={() => { setPaused(true); if (pendingSeek.current === null) savePos(true); void api.player.playing(false); }}
            onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)} onCanPlay={() => setWaiting(false)}
            onLoadedMetadata={onLoaded} onProgress={catchUp} onError={() => void onMediaError()}
            onEnded={() => { savePos(true); if (next >= 0) onIndex(next); else setPaused(true); }} />
        )}
        {skipping && <div className="absolute inset-0 bg-black" />}
        {!stream && !error && thumb && <img src={thumb} alt="" className="max-h-[40vh] opacity-40" />}
        {(waiting || skipping || !stream) && !error && resume === null && (
          <div className="absolute h-10 w-10 rounded-full border-2 border-white/70 border-t-transparent animate-spin" aria-label="Loading" />
        )}
        {error && <div className="absolute max-w-md text-center text-sm bg-black/70 rounded-lg px-4 py-3" role="alert">{error}</div>}
        {cue && (
          <div className={`absolute inset-x-0 flex justify-center pointer-events-none px-8 transition-all ${idle ? 'bottom-10' : 'bottom-28'}`}>
            <div className="bg-black/70 rounded px-3 py-1 text-center text-[clamp(16px,2.4vw,30px)] leading-snug whitespace-pre-line" data-testid="player-subtitle">{cue.text}</div>
          </div>
        )}
        {resume !== null && (
          <div className="absolute bg-black/80 rounded-2xl px-6 py-5 flex flex-col items-center gap-3" onClick={e => e.stopPropagation()} role="alertdialog" aria-label="Resume">
            <div className="text-sm text-white/80">You stopped at {fmtClock(resume)}</div>
            <div className="flex gap-2">
              <button className="h-9 px-4 rounded-lg bg-accent text-accent-fg font-medium" autoFocus
                onClick={() => { const t = resume; setResume(null); void seekTo(t, true); }}>Resume from {fmtClock(resume)}</button>
              <button className="h-9 px-4 rounded-lg bg-white/15 hover:bg-white/25" onClick={() => { setResume(null); setWantPlay(true); void video.current?.play().catch(() => {}); }}>Start over</button>
            </div>
          </div>
        )}
      </div>

      {tagsOpen && (
        <div className="absolute z-20 top-16 right-3 w-80 max-h-[calc(100%-11rem)] overflow-y-auto rounded-2xl bg-black/80 backdrop-blur border border-white/10 p-4 space-y-4"
          onClick={e => e.stopPropagation()} aria-label="Labels and stars panel">
          <div className="flex items-center text-sm font-medium">Labels & stars
            <button className="ml-auto text-white/60 hover:text-white" onClick={() => setTagsOpen(false)} aria-label="Close labels panel"><Icon name="x" size={15} /></button>
          </div>
          <TagEditor items={[item]} dark />
          <div className="text-xs text-white/50 space-y-0.5 border-t border-white/10 pt-3 break-all">
            <div>{item.path}</div>
            {info && <div>{[info.width ? `${info.width}×${info.height}` : '', info.videoCodec.toUpperCase(), fmtClock(info.duration)].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
      )}

      {/* controls (PLAY-02) */}
      <div className={`absolute bottom-0 inset-x-0 z-10 px-4 pb-3 pt-10 bg-gradient-to-t from-black/85 to-transparent transition-opacity ${idle ? 'opacity-0' : ''}`}>
        <div className="relative h-5 flex items-center cursor-pointer group" onMouseMove={onBarMove} onMouseLeave={() => setHover(null)} onClick={onBarClick}
          role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(now)} data-testid="player-seek">
          <div className="w-full h-1 group-hover:h-1.5 rounded-full bg-white/25 relative transition-all">
            <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <div className="absolute h-3.5 w-3.5 rounded-full bg-white shadow -translate-x-1/2" style={{ left: `${pct}%` }} />
          {hover && (
            <div className="absolute bottom-6 -translate-x-1/2 flex flex-col items-center gap-1 pointer-events-none" style={{ left: hover.x }}>
              {hover.img ? <img src={hover.img} alt="" className="w-48 rounded border border-white/30 bg-black" data-testid="player-preview" />
                : <div className="w-48 h-27 aspect-video rounded border border-white/20 bg-black/70" />}
              <span className="text-xs bg-black/80 rounded px-1.5">{fmtClock(hover.t)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 mt-1">
          <button className={btn} onClick={() => prev >= 0 && onIndex(prev)} disabled={prev < 0} aria-label="Previous video" title="Previous video (P)"><Icon name="back" /></button>
          <button className={btn} onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'} title="Play/pause (Space)">
            {paused ? <Icon name="play" /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>}
          </button>
          <button className={btn} onClick={() => next >= 0 && onIndex(next)} disabled={next < 0} aria-label="Next video" title="Next video (N)"><Icon name="forward" /></button>
          <button className={btn} onClick={() => void seekTo(timeNow() - 10)} aria-label="Back 10 seconds" title="Back 10 s (J)">−10</button>
          <button className={btn} onClick={() => void seekTo(timeNow() + 10)} aria-label="Forward 10 seconds" title="Forward 10 s (L)">+10</button>
          <span className="text-sm tabular-nums px-2 text-white/90" data-testid="player-time">{fmtClock(now)} / {fmtClock(duration)}</span>
          <div className="flex-1" />
          <button className={btn} onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} title="Mute (M)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 9h4l5-4v14l-5-4H4z" />{muted || volume === 0 ? <path d="m17 9 5 6m0-6-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}
            </svg>
          </button>
          <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} aria-label="Volume" className="w-24"
            onChange={e => { setVolume(Number(e.target.value)); setMuted(false); }} />
          <Menu open={menu === 'speed'} onToggle={() => setMenu(menu === 'speed' ? null : 'speed')} label={`${speed}×`} title="Speed">
            {SPEEDS.map(s => <MenuItem key={s} on={s === speed} onClick={() => { setSpeed(s); setMenu(null); }}>{s === 1 ? 'Normal' : `${s}×`}</MenuItem>)}
          </Menu>
          {info && info.audio.length > 1 && (
            <Menu open={menu === 'audio'} onToggle={() => setMenu(menu === 'audio' ? null : 'audio')} label="Audio" title="Sound track">
              {info.audio.map(a => (
                <MenuItem key={a.index} on={a.index === audio} onClick={() => void chooseAudio(a.index)}>
                  {[a.title, a.language].filter(Boolean).join(' · ') || `Track ${a.index + 1}`} <span className="text-white/50 text-xs ml-1">{a.codec.toUpperCase()} {a.channels > 2 ? `${a.channels}ch` : ''}</span>
                </MenuItem>
              ))}
            </Menu>
          )}
          <Menu open={menu === 'subs'} onToggle={() => setMenu(menu === 'subs' ? null : 'subs')} label={subId ? 'CC ●' : 'CC'} title="Subtitles">
            <MenuItem on={!subId} onClick={() => void chooseSubs(null)}>Off</MenuItem>
            {subs.map(s => (
              <MenuItem key={s.id} on={s.id === subId} disabled={!s.text} onClick={() => void chooseSubs(s.id)}
                title={s.text ? undefined : 'Picture subtitles (DVD/Blu-ray) are not supported yet'}>
                {s.label} {s.source === 'file' && <span className="text-white/50 text-xs ml-1">file</span>}
              </MenuItem>
            ))}
            <MenuItem onClick={() => void loadSubFile()}>Load subtitle file…</MenuItem>
          </Menu>
          <button className={`${btn} ${tagsOpen ? 'bg-white/15' : ''}`} onClick={() => setTagsOpen(!tagsOpen)} aria-label="Labels and stars" aria-expanded={tagsOpen} title="Labels and stars (S); 1–5 sets stars">
            <span className="text-[#f5b301]">★</span>Labels
          </button>
          <button className={btn} onClick={toggleFull} aria-label={full ? 'Exit full screen' : 'Full screen'} title="Full screen (F)"><Icon name="fit" /></button>
        </div>
      </div>
    </div>
  );
}

function Menu({ open, onToggle, label, title, children }: { open: boolean; onToggle: () => void; label: string; title: string; children: ReactNode }) {
  return (
    <div className="relative">
      <button className="h-9 px-2.5 rounded-lg hover:bg-white/15 text-sm font-medium" onClick={e => { e.stopPropagation(); onToggle(); }} aria-expanded={open} aria-label={title} title={title}>{label}</button>
      {open && (
        <div className="absolute bottom-11 right-0 min-w-44 max-h-72 overflow-y-auto rounded-xl bg-[#1b1d22] border border-white/10 shadow-2xl py-1" role="menu" onClick={e => e.stopPropagation()}>
          <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-white/50">{title}</div>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({ on, disabled, title, onClick, children }: { on?: boolean; disabled?: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button role="menuitemradio" aria-checked={!!on} disabled={disabled} title={title} onClick={onClick}
      className="w-full text-left flex items-center gap-2 px-3 h-8 text-sm hover:bg-white/10 disabled:opacity-40 whitespace-nowrap">
      <span className="w-4">{on ? '✓' : ''}</span>{children}
    </button>
  );
}
