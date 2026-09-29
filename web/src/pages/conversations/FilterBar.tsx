import { useState } from 'react';
import { Box, Checkbox, Chip, Divider, IconButton, ListItemText, Menu, MenuItem, Popover, Stack, Tooltip, Typography } from '@mui/material';
import FilterListRoundedIcon from '@mui/icons-material/FilterListRounded';
import type { Conversation } from '../../api/types';
import { FILTER_FIELDS, FILTER_LABELS, filterOptions, type FilterField, type Filters } from '../../lib/filters';

function FilterChip({ field, values, rows, onChange }: { field: FilterField; values: string[]; rows: Conversation[]; onChange: (v: string[]) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const opts = filterOptions(field, rows);
  const label = (v: string) => opts.find(o => o.value === v)?.label ?? v;
  const summary = values.length <= 2 ? values.map(label).join(', ') : `${label(values[0])} +${values.length - 1}`;
  const toggle = (v: string) => onChange(values.includes(v) ? values.filter(x => x !== v) : [...values, v]);

  return (
    <>
      <Chip
        onClick={e => setAnchor(e.currentTarget)}
        onDelete={() => onChange([])}
        variant="outlined"
        sx={{ height: 30, borderRadius: 2, bgcolor: 'background.paper', animation: 'am-scale-in 220ms both', '& .MuiChip-label': { px: 0 } }}
        label={
          <Stack direction="row" sx={{ alignItems: 'stretch', height: 28 }}>
            <Box sx={{ px: 1.25, display: 'flex', alignItems: 'center', fontWeight: 600, bgcolor: 'action.hover', borderRight: '1px solid', borderColor: 'divider' }}>{FILTER_LABELS[field]}</Box>
            <Box sx={{ px: 1.25, display: 'flex', alignItems: 'center', color: 'text.secondary', borderRight: '1px solid', borderColor: 'divider' }}>{values.length > 1 ? 'is any of' : 'is'}</Box>
            <Box sx={{ px: 1.25, display: 'flex', alignItems: 'center', fontWeight: 500, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{summary}</Box>
          </Stack>
        }
      />
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }} slotProps={{ paper: { sx: { mt: 0.5, minWidth: 240, maxHeight: 380 } } }}>
        <Box sx={{ py: 0.5 }}>
          {opts.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }}>No values in this period</Typography>}
          {opts.map(o => (
            <MenuItem key={o.value} dense onClick={() => toggle(o.value)}>
              <Checkbox size="small" checked={values.includes(o.value)} sx={{ p: 0.5, mr: 1 }} />
              <ListItemText primary={o.label} />
            </MenuItem>
          ))}
        </Box>
      </Popover>
    </>
  );
}

export function FilterBar({ filters, rows, onChange }: { filters: Filters; rows: Conversation[]; onChange: (f: FilterField, v: string[]) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const active = FILTER_FIELDS.filter(f => filters[f]?.length);
  const available = FILTER_FIELDS.filter(f => !filters[f]?.length);

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
      <Tooltip title="Add filter">
        <IconButton aria-label="Add filter" onClick={e => setAnchor(e.currentTarget)} sx={{ border: '1px solid', borderColor: 'divider', width: 32, height: 32 }}>
          <FilterListRoundedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <Typography variant="overline" color="text.secondary" sx={{ px: 2 }}>Filter by</Typography>
        <Divider sx={{ my: 0.5 }} />
        {available.map(f => (
          <MenuItem
            key={f}
            onClick={() => {
              setAnchor(null);
              const first = filterOptions(f, rows)[0];
              if (first) onChange(f, [first.value]);
            }}
          >
            {FILTER_LABELS[f]}
          </MenuItem>
        ))}
      </Menu>
      {active.map(f => (
        <FilterChip key={f} field={f} values={filters[f]!} rows={rows} onChange={v => onChange(f, v)} />
      ))}
    </Stack>
  );
}
