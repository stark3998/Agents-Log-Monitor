/** Height of the sticky app header (px); the side nav and sticky page elements sit below it. */
export const HEADER_HEIGHT = 60;
export const NAV_WIDTH = 232;
export const NAV_COLLAPSED_WIDTH = 64;
/** Height for pages that fill the viewport (grids, chat): viewport minus the header and main padding. */
export const FILL_HEIGHT = `calc(100vh - ${HEADER_HEIGHT + 44}px)`;
