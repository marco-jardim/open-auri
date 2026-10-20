import { enUS } from './en-US.ts';
import { ptBR } from './pt-BR.ts';
import type { DocsLocale } from './types.ts';
import { docsForEnvironment } from './environment.ts';

export * from './types.ts';
/** Raw content by default, also used by the locale-split loader. Project only at the UI boundary. */
export const docsContent = (locale: DocsLocale, inApp?: boolean) => {
	const content = locale === 'en-US' ? enUS : ptBR;
	return inApp === undefined ? content : docsForEnvironment(content, inApp);
};

export { creditSources } from './credits.ts';
