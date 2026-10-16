/** Route chrome metadata. Curiosities and source labels are localized by the layout. */
export interface HonoreeMeta {
	name: string;
	/** Empty when the canonical mock footer does not give dates. */
	years: string;
	curiosity: `meta_${string}`;
	sources: readonly { label: string; labelKey: `meta_${string}`; href: string }[];
}

export interface PageMeta {
	page: string;
	accent: `#${string}`;
	honoree?: HonoreeMeta;
}

export const HOMAGE_ROUTES = [
	'/',
	'/biblioteca',
	'/comparar',
	'/soe-como-x',
	'/comunidade',
	'/teste-cego',
	'/cabo',
	'/docs'
] as const;

const source = (label: string, labelKey: `meta_${string}`, href: string) => ({
	label,
	labelKey,
	href
});

const curva = {
	page: 'curva',
	accent: '#FF7A2F',
	honoree: {
		name: 'Robert Moog',
		years: '1934–2005',
		curiosity: 'meta_curva_curiosity',
		sources: [
			source(
				'fonte: US 3.475.623',
				'meta_source_patent',
				'https://patents.google.com/patent/US3475623A/en'
			),
			source('fonte: Wikipedia', 'meta_source_wikipedia', 'https://en.wikipedia.org/wiki/Minimoog')
		]
	}
} satisfies PageMeta;
const biblioteca: PageMeta = {
	page: 'biblioteca',
	accent: '#D9A441',
	honoree: {
		name: 'Geoff Emerick',
		years: '1945–2018',
		curiosity: 'meta_biblioteca_curiosity',
		sources: [source('fonte', 'meta_source', 'https://en.wikipedia.org/wiki/Geoff_Emerick')]
	}
};
const docs: PageMeta = {
	page: 'docs',
	accent: '#8C2F2F',
	honoree: {
		name: 'Harry Nyquist',
		years: '1889–1976',
		curiosity: 'meta_docs_curiosity',
		sources: [
			source(
				'fonte: Wikipedia',
				'meta_source_wikipedia',
				'https://en.wikipedia.org/wiki/Harry_Nyquist'
			),
			source(
				'fonte: critério de estabilidade',
				'meta_source_stability',
				'https://en.wikipedia.org/wiki/Nyquist_stability_criterion'
			)
		]
	}
};
/**
 * /entrar, /criar-conta, /verificar-email, /esqueci-senha, /redefinir-senha (T3.6): console
 * channel strip in homage to Rupert Neve (name in text only; never a maker's mark). Accent: the
 * painted steel blue-grey of a channel strip, #7FA7D9 (7.6:1 against --ink and --accent-ink).
 */
const auth: PageMeta = {
	page: 'auth',
	accent: '#7FA7D9',
	honoree: {
		name: 'Rupert Neve',
		years: '1926–2021',
		curiosity: 'meta_auth_curiosity',
		sources: [
			source(
				'fonte: Wikipedia',
				'meta_source_wikipedia',
				'https://en.wikipedia.org/wiki/Rupert_Neve'
			)
		]
	}
};
const placeholder = (page: string): PageMeta => ({ page, accent: '#ECE7DD' });

export const PAGE_META = {
	'/': curva,
	'/biblioteca': biblioteca,
	'/comparar': {
		page: 'comparar',
		accent: '#F2B33D',
		honoree: {
			name: 'Les Paul',
			years: '1915–2009',
			curiosity: 'meta_comparar_curiosity',
			sources: [
				source(
					'fonte: Wikipedia, Les Paul',
					'meta_source_les_paul',
					'https://en.wikipedia.org/wiki/Les_Paul#Multitrack_recording'
				),
				source(
					'fonte: Wikipedia, 8 pistas',
					'meta_source_tracks',
					'https://en.wikipedia.org/wiki/Ampex#Professional_8-track_recorders'
				)
			]
		}
	},
	'/soe-como-x': {
		page: 'soe-como-x',
		accent: '#FF3D8B',
		honoree: {
			name: 'Andy Hildebrand',
			years: '',
			curiosity: 'meta_soe_como_x_curiosity',
			sources: [
				source('fonte', 'meta_source', 'https://priceonomics.com/the-inventor-of-auto-tune/'),
				source('fonte', 'meta_source', 'https://en.wikipedia.org/wiki/AutoTune')
			]
		}
	},
	'/comunidade': {
		page: 'comunidade',
		accent: '#3DDC97',
		honoree: {
			name: 'Bob Clearmountain',
			years: '1953–',
			curiosity: 'meta_comunidade_curiosity',
			sources: [
				source(
					'fonte: Wikipedia',
					'meta_source_wikipedia',
					'https://en.wikipedia.org/wiki/Bob_Clearmountain'
				)
			]
		}
	},
	'/teste-cego': {
		page: 'teste-cego',
		accent: '#FFD27A',
		honoree: {
			name: 'Floyd Toole e Sean Olive',
			years: '',
			curiosity: 'meta_teste_cego_curiosity',
			sources: [
				source(
					'fonte: o laboratório',
					'meta_source_lab',
					'https://seanolive.blogspot.com/2009/01/video-on-how-we-measure-loudspeaker.html'
				),
				source(
					'fonte: o seletor de caixas',
					'meta_source_speakers',
					'https://seanolive.blogspot.com/2010/07/harman-kardons-quest-to-standardise.html'
				),
				source(
					'fonte: a curva-alvo de fones',
					'meta_source_target',
					'https://seanolive.blogspot.com/2022/03/the-perception-and-measurement-of.html'
				)
			]
		}
	},
	'/cabo': {
		page: 'cabo',
		accent: '#4FD1C5',
		honoree: {
			name: 'Ray Dolby',
			years: '1933–2013',
			curiosity: 'meta_cabo_curiosity',
			sources: [
				source(
					'fonte: tipo A, Wikipedia',
					'meta_source_type_a',
					'https://en.wikipedia.org/wiki/Dolby_noise-reduction_system#Dolby_A'
				),
				source(
					'fonte: Wikipedia',
					'meta_source_wikipedia',
					'https://en.wikipedia.org/wiki/Ray_Dolby'
				)
			]
		}
	},
	'/docs': docs,
	'/privacidade': docs,
	'/termos': docs,
	'/c/[id]': biblioteca,
	'/u/[apelido]': placeholder('perfil'),
	'/entrar': auth,
	'/criar-conta': auth,
	'/verificar-email': auth,
	'/esqueci-senha': auth,
	'/redefinir-senha': auth,
	'/conta': placeholder('conta'),
	'/conta/**': placeholder('conta'),
	'/admin': placeholder('admin'),
	'/admin/**': placeholder('admin')
} as const satisfies Record<string, PageMeta>;

/** Accepts a Kit route id or an actual pathname (including nested account/admin pages). */
export function getPageMeta(path: string | null): PageMeta {
	const normalized = (path ?? '/').split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
	if (Object.hasOwn(PAGE_META, normalized)) {
		return PAGE_META[normalized as keyof typeof PAGE_META];
	}
	if (/^\/c\/[^/]+$/.test(normalized)) return biblioteca;
	if (/^\/u\/[^/]+$/.test(normalized)) return PAGE_META['/u/[apelido]'];
	if (normalized.startsWith('/conta/')) return PAGE_META['/conta/**'];
	if (normalized.startsWith('/admin/')) return PAGE_META['/admin/**'];
	return placeholder('erro');
}

/** Footer requires a honoree today. Placeholder routes keep their own metadata homage-free. */
export function getFooterHonoree(meta: PageMeta): HonoreeMeta {
	return meta.honoree ?? curva.honoree;
}
