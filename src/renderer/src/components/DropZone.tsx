// Drag-and-drop area for images or a folder, with Browse buttons (IMG-01).
import { useState, type DragEvent } from 'react';
import { api } from '../api';
import { Button, Icon } from './ui';

export function DropZone({ onPaths, compact = false }: { onPaths: (paths: string[]) => void; compact?: boolean }) {
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) onPaths(paths);
  };
  const browseImages = async () => { const p = await api.openImages(); if (p.length) onPaths(p); };
  const browseFolder = async () => { const p = await api.openFolder('Choose a folder of images'); if (p) onPaths([p]); };

  return (
    <div
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={onDrop}
      className={`flex flex-col items-center justify-center text-center rounded-2xl border-2 border-dashed transition
        ${over ? 'border-accent bg-accent-soft' : 'border-line bg-panel'} ${compact ? 'p-6 gap-3' : 'p-10 gap-4 min-h-[320px]'}`}
    >
      <div className={`rounded-full p-3 ${over ? 'bg-accent text-accent-fg' : 'bg-panel-2 text-muted'}`}>
        <Icon name="upload" size={compact ? 22 : 28} />
      </div>
      <div>
        <div className={`${compact ? 'text-base' : 'text-lg'} font-semibold`}>Drop an image or a folder here</div>
        <div className="text-sm text-muted mt-1">JPG, PNG, WEBP, BMP or TIFF. Several images or a folder are upscaled one after another.</div>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={browseImages}><Icon name="image" size={16} />Browse images</Button>
        <Button onClick={browseFolder}><Icon name="folder" size={16} />Choose folder</Button>
      </div>
    </div>
  );
}
