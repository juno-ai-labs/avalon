import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton } from './primitives';

export type ImageSizing = 'width' | 'fit' | 'actual';
export type ImageZoom = ImageSizing | number;
export interface ImageZoomState {
  value: ImageZoom;
  onChange: (value: ImageZoom) => void;
}

/** Image and region overlays share real layout dimensions, including at zoom. */
export function ImageViewport({ name, src, sizing = 'width', zoomState, zoomOnDoubleClick = true, children, onLoad, onDoubleClick, ...imageProps }: Omit<ComponentProps<'img'>, 'alt' | 'children' | 'ref'> & {
  name: string;
  sizing?: ImageSizing | undefined;
  zoomState?: ImageZoomState | undefined;
  zoomOnDoubleClick?: boolean | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const imageElement = useRef<HTMLImageElement>(null);
  const zoomAnchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState({ width: 0, height: 0 });
  const [localZoom, setLocalZoom] = useState<ImageZoom>(sizing);
  const zoom = zoomState?.value ?? localZoom;
  const setZoom = zoomState?.onChange ?? setLocalZoom;
  useEffect(() => {
    setLocalZoom(sizing);
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  }, [src, sizing]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setBounds({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const widthScale = image.width && bounds.width ? Math.min(1, bounds.width / image.width) : 1;
  const scale = typeof zoom === 'number' ? zoom : zoom === 'actual' ? 1
    : zoom === 'fit' && image.height && bounds.height ? Math.min(widthScale, bounds.height / image.height) : widthScale;
  const changeZoom = (next: ImageZoom, point?: { clientX: number; clientY: number }): void => {
    const rect = imageElement.current?.getBoundingClientRect();
    const container = viewport.current;
    zoomAnchor.current = null;
    if (next !== 'fit' && rect?.width && rect.height && container) {
      const box = container.getBoundingClientRect();
      const clientX = point?.clientX ?? box.left + container.clientLeft + container.clientWidth / 2;
      const clientY = point?.clientY ?? box.top + container.clientTop + container.clientHeight / 2;
      zoomAnchor.current = { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height, clientX, clientY };
    }
    setZoom(next);
  };
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const element = viewport.current;
    const rect = imageElement.current?.getBoundingClientRect();
    if (!anchor || !element || !rect) return;
    zoomAnchor.current = null;
    element.scrollLeft += rect.left + rect.width * anchor.x - anchor.clientX;
    element.scrollTop += rect.top + rect.height * anchor.y - anchor.clientY;
  }, [scale]);
  return <div className="image-viewport">
    <div className="image-viewport-scroll" ref={viewport} tabIndex={0} role="region" aria-label={`Image preview: ${name}`} onKeyDown={(event) => {
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.currentTarget.scrollWidth > event.currentTarget.clientWidth) event.stopPropagation();
    }}>
      <div className="image-viewport-stage">
        <div className="annotation-image" style={image.width ? { width: image.width * scale } : undefined}>
          <img {...imageProps} ref={imageElement} alt={name} src={src} draggable={false} style={{ ...imageProps.style, cursor: zoomOnDoubleClick ? scale >= 1 ? 'zoom-out' : 'zoom-in' : undefined }} onDoubleClick={(event) => {
            onDoubleClick?.(event);
            if (!zoomOnDoubleClick || event.defaultPrevented || !image.width) return;
            event.preventDefault();
            event.stopPropagation();
            changeZoom(scale >= 1 ? 'fit' : 1, event);
          }} onLoad={(event) => {
            setImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
            onLoad?.(event);
          }} />
          {children}
        </div>
      </div>
    </div>
    <div className="image-viewport-toolbar" role="group" aria-label="Image zoom">
      <IconButton label="Zoom out" tooltipSide="top" onClick={() => changeZoom(scale / 1.25)}><ZoomOut size={16} /></IconButton>
      <button type="button" className="image-viewport-scale" aria-label="Show image at 100%" onClick={() => changeZoom(1)}>{Math.round(scale * 100)}%</button>
      <IconButton label="Zoom in" tooltipSide="top" onClick={() => changeZoom(scale * 1.25)}><ZoomIn size={16} /></IconButton>
      <button type="button" aria-pressed={zoom === 'fit'} onClick={() => changeZoom('fit')}>Fit</button>
    </div>
  </div>;
}
