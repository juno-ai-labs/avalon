import { useNavigate } from 'react-router-dom';

import { canvasRoute, useCanvasCreations } from '../lib/canvases';
import { Button, ErrorNotice } from './primitives';

/** The shell reports failed background work even after its Canvas was left. */
export function CanvasCreationNotices(): React.JSX.Element {
  const creations = useCanvasCreations();
  const navigate = useNavigate();
  return <>{Object.entries(creations).map(([id, creation]) => creation.error && <ErrorNotice
    key={id} occurrence={creation.error} title="The Canvas could not be made"
  >
    <p>Your opening prompt and unsent draft are kept in the Canvas.</p>
    <Button onClick={() => void navigate(canvasRoute(id))}>Open Canvas</Button>
  </ErrorNotice>)}</>;
}
