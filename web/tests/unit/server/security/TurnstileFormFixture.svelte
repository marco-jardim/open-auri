<!-- Turnstile inside a form, as on the auth and account pages: errors wait for the user. -->
<script lang="ts">
	import Turnstile from '#lib/components/security/Turnstile.svelte';

	let { siteKey = 'k', action = 'sign-in' }: { siteKey?: string; action?: string } = $props();
</script>

<form method="POST">
	<label for="fixture-email">E-mail</label>
	<input id="fixture-email" name="email" type="email" />
	<Turnstile {siteKey} {action} />
	<button type="submit">Enviar</button>
</form>
