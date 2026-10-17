// Page-facing barrel: only light modules (triggers, the tour host and controller, glossary
// titles). The registries with prose — `tourSteps` (#lib/comprehension/steps.ts) and
// `explainers` / `gateReasonContext` (#lib/comprehension/explainers.ts) — are imported from
// their modules where needed, so this barrel never pulls them into a page's initial JS (FUX.B).
export { default as Tour } from './Tour.svelte';
export { default as Explainer } from './Explainer.svelte';
export { default as GlossaryLink } from './GlossaryLink.svelte';
export { default as TourTrigger } from './TourTrigger.svelte';
export { tour, createTour, TOUR_STORAGE_KEY } from '#lib/comprehension/tour.svelte.ts';
export { explainerHeadings } from '#lib/comprehension/explainer-titles.ts';
export { glossary, glossaryHref } from '#lib/comprehension/glossary.ts';
export type { TourController, TourHistory, TourStatus } from '#lib/comprehension/tour.svelte.ts';
export type { TourPage } from '#lib/comprehension/steps.ts';
export type { ExplainerId } from '#lib/comprehension/explainer-titles.ts';
export type { GlossaryTerm } from '#lib/comprehension/glossary.ts';
