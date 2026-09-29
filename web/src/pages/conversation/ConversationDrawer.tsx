import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Drawer } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { ConversationView } from './ConversationView';

const WIDTH_KEY = 'am-drawer-width';
const MIN = 420;

function clampWidth(w: number) {
  return Math.max(MIN, Math.min(w, window.innerWidth - 120));
}

/** Non-modal, resizable right drawer; the table behind stays interactive. */
export function ConversationDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [width, setWidth] = useState(() => clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || 760));
  const [dragging, setDragging] = useState(false);
  const lastId = useRef<string | null>(id);
  if (id) lastId.current = id;

  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !target?.closest('input, textarea, [role="menu"], [role="dialog"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, onClose]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev: PointerEvent) => setWidth(clampWidth(window.innerWidth - ev.clientX));
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWidth(w => { localStorage.setItem(WIDTH_KEY, String(w)); return w; });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  const shownId = id ?? lastId.current;

  return (
    <Drawer
      anchor="right"
      variant="persistent"
      open={!!id}
      transitionDuration={{ enter: 320, exit: 220 }}
      slotProps={{
        paper: {
          sx: {
            width, maxWidth: '100vw', borderLeft: '1px solid', borderColor: 'divider', bgcolor: 'background.default',
            boxShadow: '-24px 0 48px rgba(0,0,0,.28)', overflow: 'visible', userSelect: dragging ? 'none' : undefined,
          },
          role: 'dialog',
          'aria-label': 'Conversation',
        } as object,
      }}
    >
      <Box
        onPointerDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        sx={{
          position: 'absolute', left: -4, top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 2,
          '&::after': { content: '""', position: 'absolute', left: 3, top: 0, bottom: 0, width: 2, bgcolor: dragging ? 'primary.main' : 'transparent', transition: 'background-color 150ms' },
          '&:hover::after': { bgcolor: 'primary.main' },
        }}
      />
      {shownId && (
        <ConversationView
          key={shownId}
          id={shownId}
          onClose={onClose}
          onExpand={() => navigate(`/conversations/${shownId}`)}
        />
      )}
    </Drawer>
  );
}
