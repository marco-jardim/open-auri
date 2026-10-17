import type { TourPage } from './steps.ts';

export const TOUR_STORAGE_KEY = 'oa.tour.v1';
export type TourStatus = 'visto' | 'dispensado';
export type TourHistory = Partial<Record<TourPage, TourStatus>>;
type TourStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface TourEnvironment {
	storage: () => TourStorage | undefined;
	isDesktop: () => boolean;
}

const pages: readonly TourPage[] = [
	'curva',
	'comunidade',
	'cabo',
	'soe-como-x',
	'comparar',
	'teste-cego',
	'biblioteca'
];

function parseHistory(raw: string | null): TourHistory {
	if (raw === null) return {};
	const value: unknown = JSON.parse(raw);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Invalid tour history');
	}
	const history: TourHistory = {};
	for (const page of pages) {
		const status: unknown = Object.getOwnPropertyDescriptor(value, page)?.value;
		if (status === 'visto' || status === 'dispensado') history[page] = status;
		else if (status !== undefined) throw new Error('Invalid tour status');
	}
	return history;
}

/** Lazy browser access: importing during SSR never reads storage or mutates shared state. */
export function createTour(
	environment: TourEnvironment = {
		storage: () => (typeof window === 'undefined' ? undefined : window.localStorage),
		isDesktop: () =>
			typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
	}
) {
	let history = $state<TourHistory>({});
	let activePage = $state<TourPage | null>(null);
	let stepIndex = $state(0);
	let storageError = $state<'read' | 'write' | 'corrupt' | null>(null);
	let loaded = false;

	function load() {
		if (loaded) return;
		loaded = true;
		let raw: string | null;
		try {
			raw = environment.storage()?.getItem(TOUR_STORAGE_KEY) ?? null;
		} catch {
			storageError = 'read';
			return;
		}
		try {
			history = parseHistory(raw);
		} catch {
			storageError = 'corrupt';
			history = {};
		}
	}

	function persist(remove = false) {
		try {
			const storage = environment.storage();
			if (remove) storage?.removeItem(TOUR_STORAGE_KEY);
			else storage?.setItem(TOUR_STORAGE_KEY, JSON.stringify(history));
		} catch {
			// Keep this session usable when storage is disabled or full.
			storageError = 'write';
		}
	}

	function finish(page: TourPage, status: TourStatus) {
		load();
		history = { ...history, [page]: status };
		persist();
		if (activePage === page) activePage = null;
	}

	return {
		get activePage() {
			return activePage;
		},
		get stepIndex() {
			return stepIndex;
		},
		get history(): Readonly<TourHistory> {
			return history;
		},
		get storageError() {
			return storageError;
		},
		shouldAutoOpen(page: TourPage) {
			if (!environment.isDesktop()) return false;
			load();
			return !history[page] && activePage === null;
		},
		open(page: TourPage) {
			load();
			stepIndex = 0;
			activePage = page;
		},
		goTo(index: number) {
			stepIndex = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
		},
		markSeen(page: TourPage) {
			finish(page, 'visto');
		},
		dismiss(page: TourPage) {
			finish(page, 'dispensado');
		},
		reset(page?: TourPage) {
			load();
			if (page) {
				const next = { ...history };
				delete next[page];
				history = next;
			} else history = {};
			if (!page || activePage === page) activePage = null;
			stepIndex = 0;
			persist(!page);
		}
	};
}

export type TourController = ReturnType<typeof createTour>;
export const tour = createTour();
