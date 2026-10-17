// Curated public nickname blocklist, v1 (pt-BR / en-US); no user data.
// Entries are lowercase, separator-free moderation skeletons (see username.ts).
// `tokens` match whole tokens or the whole compact nickname, never arbitrary substrings.
// Only explicitly listed, unambiguous `substrings` may match inside another word.
// Matching also folds accents, look-alikes, leet, separators, numeric badges and extra letters;
// the existing reserved.ts list is merged by the matcher, not copied here.
export const USERNAME_BLOCKLIST_VERSION = 1;

export const USERNAME_BLOCKLIST = {
	// Racist slurs; ambiguous short words stay token-only.
	racism: {
		tokens: [
			'coon',
			'chlnk',
			'gook',
			'splc',
			'klke',
			'crloulo',
			'crloula',
			'macaco',
			'nlgga',
			'darkle'
		],
		substrings: ['nlgger']
	},
	// Homophobic and transphobic slurs, not neutral identities (gay, trans, queer).
	antiLgbtq: {
		tokens: ['fag', 'dyke', 'blcha', 'blchlnha', 'vlado', 'veado', 'traveco', 'trava'],
		substrings: ['faggot', 'tranny', 'shemale', 'sapatao', 'sapatona']
	},
	// Misogynistic slurs; token boundaries spare words such as computador and disputa.
	misogyny: {
		tokens: ['bltch', 'cunt', 'slut', 'whore', 'puta', 'vadla', 'plranha'],
		substrings: ['femlnazl']
	},
	// Xenophobic / ethnoreligious abuse; nationality and religion names are not blocked.
	xenophobia: {
		tokens: ['pakl', 'bollta'],
		substrings: ['wetback', 'raghead', 'towelhead', 'beaner']
	},
	// Ableist slurs, not neutral disability names (autista, surdo, cego).
	ableism: {
		tokens: ['retard', 'retarded', 'retardado', 'retardada', 'spastlc', 'aleljado'],
		substrings: ['mongolold', 'mongololde']
	},
	// Explicit supremacist identifiers and slogans; no ambiguous numbers / abbreviations.
	supremacy: {
		tokens: ['nazl', 'nazlsta'],
		substrings: ['neonazl', 'hellhltler', 'kukluxklan', 'whltepower', 'whltesupremacy']
	},
	// Authority variants absent from reserved.ts; all existing staff/system names are reused.
	administration: {
		tokens: [
			'admlns',
			'admlnlstradora',
			'admlnlstradores',
			'admlnlstrators',
			'admlnlstracao',
			'admlnlstratlon',
			'moderadora',
			'moderadores',
			'moderators',
			'moderatlon',
			'oflclals',
			'offlclals',
			'offlclalsupport'
		],
		substrings: []
	},
	// Headphones / IEMs (including short brands, which must never match inside words).
	headphoneBrands: {
		tokens: [
			'akg',
			'jbl',
			'sony',
			'bose',
			'beats',
			'phlllps',
			'panasonlc',
			'bowerswllklns',
			'bangolufsen',
			'sonos',
			'grado',
			'shure',
			'stax',
			'focal',
			'audeze',
			'hlflman',
			'moondrop',
			'truthear',
			'tangzu',
			'tlnhlfl',
			'dunu',
			'letshuoer',
			'thleaudlo',
			'klwlears',
			'campflreaudlo',
			'emplreears',
			'westone',
			'ultlmateears',
			'gaaudlo', // 64 Audio
			'thz', // 7Hz
			'koss',
			'flnal',
			'qdc',
			'kz',
			'cca'
		],
		substrings: ['sennhelser', 'audlotechnlca', 'beyerdynamlc', 'etymotlc']
	},
	// DACs / amplifiers and audio electronics.
	dacBrands: {
		tokens: [
			'fllo',
			'topplng',
			'smsl',
			'schllt',
			'lfl',
			'qudellx',
			'questyle',
			'chord',
			'shanllng',
			'hlby',
			'xduoo',
			'gustard',
			'burson',
			'rme',
			'denon',
			'marantz',
			'yamaha',
			'onkyo',
			'technlcs',
			'astellkem'
		],
		substrings: []
	},
	// Audio cables / connectors.
	cableBrands: {
		tokens: [
			'audloquest',
			'klmber',
			'cardas',
			'nordost',
			'mogaml',
			'canare',
			'belden',
			'neutrlk',
			'furutech',
			'xlnhs',
			'trlpowln',
			'nlcehck'
		],
		substrings: []
	},
	// Audio platforms / services (ordinary words such as tidal remain token-only).
	audioPlatforms: {
		tokens: [
			'spotlfy',
			'tldal',
			'deezer',
			'qobuz',
			'roon',
			'bandcamp',
			'applemuslc',
			'amazonmuslc'
		],
		substrings: ['soundcloud', 'youtubemuslc']
	},
	// Major general trademarks; short or ordinary-language brands remain token-only.
	generalBrands: {
		tokens: [
			'apple',
			'google',
			'amazon',
			'meta',
			'samsung',
			'lg',
			'lntel',
			'amd',
			'nvldla',
			'lbm',
			'hp',
			'dell',
			'lenovo',
			'asus',
			'acer',
			'motorola',
			'huawel',
			'xlaoml',
			'nlke',
			'adldas',
			'cocacola',
			'pepsl',
			'dlsney',
			'tesla',
			'toyota',
			'bmw',
			'netfllx',
			'tlktok',
			'youtube',
			'whatsapp'
		],
		substrings: ['mlcrosoft', 'facebook', 'lnstagram', 'mcdonalds', 'starbucks']
	}
} as const satisfies Record<string, { tokens: readonly string[]; substrings: readonly string[] }>;
