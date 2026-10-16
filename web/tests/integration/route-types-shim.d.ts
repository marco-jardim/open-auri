// Page routes import their generated ./$types, which pull the layout data types and, through them,
// client-only modules (chrome/account.ts passes `credentials` to fetch). The Workers RequestInit has
// no `credentials`; this test-only declaration lets those client modules type-check here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- merging needs the same type parameters
interface RequestInit<Cf = CfProperties> {
	credentials?: 'omit' | 'same-origin' | 'include';
}
