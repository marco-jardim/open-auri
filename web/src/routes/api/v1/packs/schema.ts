// Body schema shared by POST /api/v1/packs and PUT /api/v1/packs/[id] (T4.11). Lengths are
// re-checked after normalization by the service; the caps here only bound the input.
import { z } from 'zod';
import { LICENSES, PACK_ITEMS_MAX, PACK_VISIBILITIES } from '#lib/server/social/types.ts';

const Item = z
	.union([
		z.string().max(64),
		z.object({ lineageId: z.string().max(64), license: z.enum(LICENSES).optional() }).strict()
	])
	.transform((item) => (typeof item === 'string' ? { lineageId: item } : item));

export const PackBody = z
	.object({
		name: z.string().max(400).optional(),
		description: z.string().max(4000).optional(),
		visibility: z.enum(PACK_VISIBILITIES).optional(),
		items: z.array(Item).max(PACK_ITEMS_MAX).optional()
	})
	.strict();
