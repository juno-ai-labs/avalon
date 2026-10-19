// The shared clock lives with the components that read it in `@rally/ui`, so a
// title-menu level ticks on the same interval as the desktop's own labels.
export { RELATIVE_TIME_REFRESH_MS, useNow } from '@rally/ui/lib/clock';
