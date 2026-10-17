import { m } from '#lib/paraglide/messages.js';

function step(id: string, title: () => string, body: () => string) {
	return {
		id,
		selector: `[data-tour="${id}"]`,
		title,
		body,
		titleKey: `tour_${id.replaceAll('-', '_')}_title`,
		bodyKey: `tour_${id.replaceAll('-', '_')}_body`
	};
}

export const tourSteps = {
	curva: [
		step(
			'curva-layers',
			() => m.tour_curva_layers_title(),
			() => m.tour_curva_layers_body()
		),
		step(
			'curva-chart',
			() => m.tour_curva_chart_title(),
			() => m.tour_curva_chart_body()
		),
		step(
			'curva-presets',
			() => m.tour_curva_presets_title(),
			() => m.tour_curva_presets_body()
		),
		step(
			'curva-write',
			() => m.tour_curva_write_title(),
			() => m.tour_curva_write_body()
		)
	],
	comunidade: [
		step(
			'comunidade-channels',
			() => m.tour_comunidade_channels_title(),
			() => m.tour_comunidade_channels_body()
		),
		step(
			'comunidade-scope',
			() => m.tour_comunidade_scope_title(),
			() => m.tour_comunidade_scope_body()
		),
		step(
			'comunidade-publish',
			() => m.tour_comunidade_publish_title(),
			() => m.tour_comunidade_publish_body()
		),
		step(
			'comunidade-blind',
			() => m.tour_comunidade_blind_title(),
			() => m.tour_comunidade_blind_body()
		)
	],
	cabo: [
		step(
			'cabo-connect',
			() => m.tour_cabo_connect_title(),
			() => m.tour_cabo_connect_body()
		),
		step(
			'cabo-bytes',
			() => m.tour_cabo_bytes_title(),
			() => m.tour_cabo_bytes_body()
		),
		step(
			'cabo-checklist',
			() => m.tour_cabo_checklist_title(),
			() => m.tour_cabo_checklist_body()
		),
		step(
			'cabo-tape',
			() => m.tour_cabo_tape_title(),
			() => m.tour_cabo_tape_body()
		),
		step(
			'cabo-journal',
			() => m.tour_cabo_journal_title(),
			() => m.tour_cabo_journal_body()
		)
	],
	'soe-como-x': [
		step(
			'soe-headphone',
			() => m.tour_soe_headphone_title(),
			() => m.tour_soe_headphone_body()
		),
		step(
			'soe-target',
			() => m.tour_soe_target_title(),
			() => m.tour_soe_target_body()
		),
		step(
			'soe-solver',
			() => m.tour_soe_solver_title(),
			() => m.tour_soe_solver_body()
		),
		step(
			'soe-ab',
			() => m.tour_soe_ab_title(),
			() => m.tour_soe_ab_body()
		),
		step(
			'soe-editor',
			() => m.tour_soe_editor_title(),
			() => m.tour_soe_editor_body()
		)
	],
	comparar: [
		step(
			'comparar-tracks',
			() => m.tour_comparar_tracks_title(),
			() => m.tour_comparar_tracks_body()
		),
		step(
			'comparar-arm',
			() => m.tour_comparar_arm_title(),
			() => m.tour_comparar_arm_body()
		),
		step(
			'comparar-level',
			() => m.tour_comparar_level_title(),
			() => m.tour_comparar_level_body()
		)
	],
	'teste-cego': [
		step(
			'cego-prepare',
			() => m.tour_cego_prepare_title(),
			() => m.tour_cego_prepare_body()
		),
		step(
			'cego-listen',
			() => m.tour_cego_listen_title(),
			() => m.tour_cego_listen_body()
		),
		step(
			'cego-result',
			() => m.tour_cego_result_title(),
			() => m.tour_cego_result_body()
		)
	],
	biblioteca: [
		step(
			'biblioteca-shelf',
			() => m.tour_biblioteca_shelf_title(),
			() => m.tour_biblioteca_shelf_body()
		),
		step(
			'biblioteca-card',
			() => m.tour_biblioteca_card_title(),
			() => m.tour_biblioteca_card_body()
		),
		step(
			'biblioteca-share',
			() => m.tour_biblioteca_share_title(),
			() => m.tour_biblioteca_share_body()
		)
	]
} as const;

export type TourPage = keyof typeof tourSteps;
