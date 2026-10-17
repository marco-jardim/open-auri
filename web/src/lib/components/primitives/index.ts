// Design system v2.1 primitives (FUX.1, spec docs/plans/fux-spec.md §2.6). Recipes live in
// src/lib/styles/components.css; use these instead of local buttons, chips or lamps.
export { default as Button, type ButtonSize, type ButtonVariant } from './Button.svelte';
export { default as IconButton } from './IconButton.svelte';
export { default as Chip, type ChipTone, type MeterMode } from './Chip.svelte';
export { default as Panel } from './Panel.svelte';
export { default as Field, type FieldControl } from './Field.svelte';
export { default as Tooltip, type TooltipTrigger } from './Tooltip.svelte';
export { default as Lamp, type LampTone } from './Lamp.svelte';
export { default as Skeleton } from './Skeleton.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Menu, type MenuItem } from './Menu.svelte';
