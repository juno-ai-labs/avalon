import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton } from './primitives';

export type ImageSizing = 'width' | 'fit' | 'actual';

/** Image and region overlays share real layout dimensions, including at zoom. */
export function ImageViewport({ name, src, sizing = 'width', zoomOnDoubleClick = true, children, onLoad, onDoubleClick, ...imageProps }: Omit<ComponentProps<'img'>, 'alt' | 'children' | 'ref'> & {
  name: string;
  sizing?: ImageSizing | undefined;
  zoomOnDoubleClick?: boolean | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const imageElement = useRef<HTMLImageElement>(null);
  const zoomAnchor = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [image, setImage] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<ImageSizing | number>(sizing);
  useEffect(() => {
    setZoom(sizing);
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
    <div className="image-viewport-scroll" ref={viewport} tabIndex={0} role="region" aria-label={`Image preview: ${name}`}>
      <div className="image-viewport-stage">
        <div className="annotation-image" style={image.width ? { width: image.width * scale } : undefined}>
          <img {...imageProps} ref={imageElement} alt={name} src={src} draggable={false} style={{ ...imageProps.style, cursor: zoomOnDoubleClick ? scale >= 1 ? 'zoom-out' : 'zoom-in' : undefined }} onDoubleClick={(event) => {
            onDoubleClick?.(event);
            if (!zoomOnDoubleClick || event.defaultPrevented || !image.width) return;
            event.preventDefault();
            event.stopPropagation();
            if (scale >= 1) setZoom('fit');
            else {
              const rect = event.currentTarget.getBoundingClientRect();
              zoomAnchor.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, clientX: event.clientX, clientY: event.clientY };
              setZoom(1);
            }
          }} onLoad={(event) => {
            setImage({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
            onLoad?.(event);
          }} />
          {children}
        </div>
      </div>
    </div>
    <div className="image-viewport-toolbar" role="group" aria-label="Image zoom">
      <IconButton label="Zoom out" tooltipSide="top" onClick={() => setZoom(scale / 1.25)}><ZoomOut size={16} /></IconButton>
      <button type="button" className="image-viewport-scale" aria-label="Show image at 100%" onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
      <IconButton label="Zoom in" tooltipSide="top" onClick={() => setZoom(scale * 1.25)}><ZoomIn size={16} /></IconButton>
      <button type="button" aria-pressed={zoom === 'fit'} onClick={() => setZoom('fit')}>Fit</button>
    </div>
  </div>;
}
