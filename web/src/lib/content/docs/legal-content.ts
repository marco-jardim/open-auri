import { privacyPtBR } from './privacy.pt-BR.ts';
import { privacyEnUS } from './privacy.en-US.ts';
import { termsPtBR } from './terms.pt-BR.ts';
import { termsEnUS } from './terms.en-US.ts';
import type { DocsLocale } from './types.ts';

export function legalContent(kind: 'privacy' | 'terms', locale: DocsLocale) {
	if (kind === 'privacy') return locale === 'en-US' ? privacyEnUS : privacyPtBR;
	return locale === 'en-US' ? termsEnUS : termsPtBR;
}
