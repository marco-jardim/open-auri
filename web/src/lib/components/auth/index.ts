// Auth pages (T3.6). Route files import `kit-enhance.ts` (needs `$app/forms`) and the
// `*.server.ts` modules directly; everything exported here renders in component tests.
export { default as AuthShell } from './AuthShell.svelte';
export { default as AuthField } from './AuthField.svelte';
export { default as FormAlert } from './FormAlert.svelte';
export { default as ForgotForm } from './ForgotForm.svelte';
export { default as HumanCheck } from './HumanCheck.svelte';
export { default as PasswordStrength } from './PasswordStrength.svelte';
export { default as ResendForm } from './ResendForm.svelte';
export { default as ResetForm } from './ResetForm.svelte';
export { default as SignInForm } from './SignInForm.svelte';
export { default as SignUpForm } from './SignUpForm.svelte';
export { default as SignupClosed } from './SignupClosed.svelte';
export { default as SubmitSwitch } from './SubmitSwitch.svelte';
export { default as TwoFactorForm } from './TwoFactorForm.svelte';
export { default as VerifyEmailView } from './VerifyEmailView.svelte';
export { AUTH_TURNSTILE_ACTIONS, TURNSTILE_FIELD } from './fields.ts';
export { AUTH_PAGES, afterSignIn, safeNext, withNext } from './next.ts';
export {
	estimateStrength,
	PASSWORD_MAX,
	PASSWORD_MIN,
	type StrengthEstimate,
	type StrengthLevel
} from './password-strength.ts';
export { resetToken, signInNotice, verifyStatus, type VerifyStatus } from './status.ts';
export type { AuthErrorKind, AuthFormState, FieldIssue, FormEnhancer } from './types.ts';
