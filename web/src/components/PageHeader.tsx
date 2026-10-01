import type { ReactNode } from 'react';
import { Box, Stack, Typography, alpha } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { findNavItem } from '../lib/nav';

/**
 * Standard page heading: section eyebrow, icon, title, what the page shows and what it's for (from the nav config),
 * with page actions on the right.
 */
export function PageHeader({ title, description, actions }: {
  title?: string; description?: ReactNode; actions?: ReactNode;
}) {
  const { pathname } = useLocation();
  const nav = findNavItem(pathname);
  const item = nav?.item;
  return (
    <Box data-testid="page-header" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 3, rowGap: 1.5 }}>
      <Box sx={{ flex: '1 1 440px', minWidth: 0 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          {item && (
            <Box aria-hidden sx={theme => ({
              width: 40, height: 40, borderRadius: 2.5, flexShrink: 0, display: 'grid', placeItems: 'center',
              color: 'primary.main', bgcolor: alpha(theme.palette.primary.main, 0.12), '& svg': { fontSize: 22 },
            })}>
              {item.icon}
            </Box>
          )}
          <Box sx={{ minWidth: 0 }}>
            {nav && <Typography variant="overline" component="p" sx={{ color: 'text.secondary', lineHeight: 1.4, display: 'block' }}>{nav.section.title}</Typography>}
            <Typography variant="h5" component="h2" sx={{ lineHeight: 1.2 }}>{title ?? item?.label}</Typography>
          </Box>
        </Stack>
        {(description ?? item?.description) && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25, maxWidth: 860 }}>{description ?? item?.description}</Typography>
        )}
        {item?.purpose && (
          <Typography variant="body2" sx={{ mt: 0.5, maxWidth: 860, color: 'text.secondary' }}>
            <Box component="span" sx={{ color: 'text.primary', fontWeight: 600, mr: 0.75 }}>Purpose</Box>
            {item.purpose}
          </Typography>
        )}
      </Box>
      {actions && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1, pt: { md: 0.5 } }}>
          {actions}
        </Stack>
      )}
    </Box>
  );
}
