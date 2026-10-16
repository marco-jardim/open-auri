import source from '../../../../../docs/legal/privacy-policy.en-US.md?raw';
import { parseLegalMarkdown } from './legal.ts';

export const privacyEnUS = parseLegalMarkdown(
	source.replace(
		'Este documento não é aconselhamento jurídico e deve ser revisado por um advogado antes da publicação.',
		'This document is not legal advice and must be reviewed by a lawyer before publication.'
	),
	'en-US'
);
