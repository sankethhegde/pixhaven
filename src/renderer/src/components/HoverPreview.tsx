// 1.0.8: resting the mouse on a video thumbnail plays it there, muted, like a video site. It opens through the
// player's own pipeline (so every format plays: directly, repackaged or converted), from where it was left or a bit in
// (past black intros), and is let go as soon as the mouse moves away.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { playerCaps } from './Player';

export const HOVER_DELAY_MS = 900;

export function HoverPreview({ path, resumeAt }: { path: string; resumeAt?: number | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const start = useRef(0);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let live = true;
    let session: string | null = null;
    void api.player.open(path, playerCaps()).then(async i => {
      session = i.session;
      if (!live) { void api.player.close(i.session); return; }
      const at = resumeAt && resumeAt > 1 && resumeAt < i.duration - 3 ? resumeAt : i.duration > 20 ? Math.min(i.duration * 0.1, 30) : 0;
      if (i.mode === 'direct') { start.current = at; setUrl(i.url); return; }
      const s = at > 0 ? await api.player.seek(i.session, at).catch(() => null) : null;
      if (live) setUrl((s ?? i).url);
    }).catch(() => {});
    return () => { live = false; if (session) void api.player.close(session); };
  }, [path, resumeAt]);
  if (!url) return null;
  return (
    <video ref={video} src={url} muted autoPlay loop playsInline data-testid="hover-preview"
      onLoadedMetadata={() => { if (start.current && video.current) video.current.currentTime = start.current; }}
      className="absolute inset-0 w-full h-full object-cover rounded-lg bg-black pointer-events-none" />
  );
}
