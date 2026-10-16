<script lang="ts">
	import { AuthShell } from '#lib/components/auth/index.ts';
</script>

<AuthShell channel="01" title="Entrar" lede="Entre com o e-mail e a senha da sua conta.">
	<p>conteúdo</p>
	{#snippet footer()}
		<a href="/esqueci-senha">Esqueci a senha</a>
	{/snippet}
</AuthShell>
