import { enUS } from './en-US.ts';
import { ptBR } from './pt-BR.ts';
import type { DocsLocale } from './types.ts';

export * from './types.ts';
export const docsContent = (locale: DocsLocale) => (locale === 'en-US' ? enUS : ptBR);

export { creditSources } from './credits.ts';
