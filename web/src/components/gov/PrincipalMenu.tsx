import { useState } from 'react';
import { Avatar, Box, Button, ButtonBase, Chip, Divider, Popover, Stack, Typography } from '@mui/material';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import { useAuth } from '../../auth/context';
import { expandRoles } from '../../api/governance';

/** Signed-in principal + roles (GET /api/gov/me) in the top bar. */
export function PrincipalMenu() {
  const { principal, mode, signOut, governance } = useAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!principal) return null;
  const name = principal.name || principal.id;
  const roles = [...expandRoles(principal.roles)];
  const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('') || '?';
  return (
    <>
      <ButtonBase
        onClick={e => setAnchor(e.currentTarget)}
        aria-label={`Signed in as ${name}`}
        aria-haspopup="dialog"
        sx={{ borderRadius: 99, p: 0.25, ml: 0.5, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' } }}
      >
        <Avatar sx={{ width: 28, height: 28, fontSize: 12, fontWeight: 600, bgcolor: 'action.selected', color: 'text.primary', border: '1px solid', borderColor: 'divider' }}>{initials}</Avatar>
      </ButtonBase>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 300, mt: 0.5 }, role: 'dialog', 'aria-label': 'Account' } as object }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" noWrap>{name}</Typography>
          <Typography variant="caption" component="div" noWrap>
            {principal.kind === 'local' ? 'Local mode · loopback access' : `${principal.kind} · ${mode === 'entra' ? 'Microsoft Entra ID' : 'local'}`}
          </Typography>
        </Box>
        <Divider />
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="overline" color="text.secondary" component="div">Roles</Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            {roles.length ? roles.map(r => <Chip key={r} size="small" variant="outlined" label={r} />) : <Typography variant="body2" color="text.secondary">No roles assigned</Typography>}
          </Stack>
          {!governance && <Typography variant="caption" component="div" sx={{ mt: 1 }}>Governance API unavailable.</Typography>}
        </Box>
        {signOut && (
          <>
            <Divider />
            <Box sx={{ p: 1 }}>
              <Button fullWidth size="small" startIcon={<LogoutRoundedIcon />} onClick={signOut} sx={{ justifyContent: 'flex-start' }}>Sign out</Button>
            </Box>
          </>
        )}
      </Popover>
    </>
  );
}
