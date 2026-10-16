import source from '../../../../../docs/legal/politica-de-privacidade.md?raw';
import { parseLegalMarkdown } from './legal.ts';

export const privacyPtBR = parseLegalMarkdown(source, 'pt-BR');
