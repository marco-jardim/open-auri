/** Phase 2 routes only; Comunidade belongs to Phase 4. */
export const routes = [
	{ path: '/', name: 'curva' },
	{ path: '/biblioteca', name: 'biblioteca' },
	{ path: '/comparar', name: 'comparar' },
	{ path: '/soe-como-x', name: 'soe-como-x' },
	{ path: '/teste-cego', name: 'teste-cego' },
	{ path: '/cabo', name: 'cabo' },
	{ path: '/docs', name: 'docs' },
	{ path: '/privacidade', name: 'privacidade' },
	{ path: '/termos', name: 'termos' },
	{ path: '/offline', name: 'offline' }
] as const;
