import type { Settings, ToolCall } from './types';
import type { Target } from './page';

/**
 * Words on a button or link that usually mean "this commits something":
 * money, messages, deletion, sign-ups. English plus a few German terms.
 */
export const RISKY_WORDS =
  /(^|[^\p{L}])(pay|buy|purchase|order|checkout|check out|send|submit|delete|remove|confirm|transfer|withdraw|post|publish|sign ?up|register|subscribe|unsubscribe|book|reserve|apply|donate|accept|agree|bid|vote|cancel (?:my |your |the )?(?:subscription|order|booking|plan|membership|account)|kaufen|bestellen|bezahlen|zahlen|zahlungspflichtig|überweisen|senden|absenden|löschen|kündigen|stornieren|buchen|reservieren|bestätigen|anmelden)([^\p{L}]|$)/iu;

const SENSITIVE_FIELD = /card|cvv|cvc|iban|bic|ssn|passport|password|passwort|tax.?id|steuer/i;

const MUTATING = new Set(['click', 'type', 'fill_form', 'select_option', 'press_key', 'navigate', 'go_back']);

/**
 * Decides whether the user must approve an action first.
 * Returns the question to show, or null to proceed.
 */
export function needsConfirmation(
  mode: Settings['confirmMode'],
  call: ToolCall,
  target: Target | null,
  label: string,
): string | null {
  if (mode === 'never' || !MUTATING.has(call.name)) return null;
  if (mode === 'always') return `Allow: ${label}?`;

  if (call.name === 'click' && target) {
    // Ticking a box is reversible; the commitment happens at the submit, which is checked.
    const toggle = target.type === 'checkbox' || target.type === 'radio';
    if (!toggle && commits(target)) return `This looks like it submits or commits something. Allow: ${label}?`;
  }
  // A key press acts on whatever has focus: Enter submits forms and activates buttons, Space activates buttons.
  if (call.name === 'press_key' && target) {
    const key = String(call.args.key);
    const button = target.tag === 'button' || target.tag === 'a' || ['submit', 'button'].includes(target.type);
    if ((key === 'Enter' || key === 'Space') && button && commits(target)) {
      return `This activates “${target.name}”, which looks like it submits or commits something. Allow: ${label}?`;
    }
    if (key === 'Enter' && !button && target.inForm && !target.isSearch) {
      return `Pressing Enter here will probably submit the form. Allow: ${label}?`;
    }
  }
  if (call.name === 'type' && target) {
    if (isSensitiveField(target)) return `This is a sensitive field. Allow: ${label}?`;
    if (call.args.submit && !target.isSearch) return `This will submit the form. Allow: ${label}?`;
  }
  return null;
}

/** A control that submits a form, or whose visible name or description says it commits something. */
function commits(target: Target): boolean {
  return target.type === 'submit' || RISKY_WORDS.test(target.name) || RISKY_WORDS.test(target.desc);
}

/**
 * Leaving for another site needs approval unless the user named that site themselves.
 * This stops a page from talking the agent into carrying data to an address of its choosing.
 */
export function needsNavigationApproval(url: string, currentUrl: string, userText: string): boolean {
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return true;
  }
  const base = (h: string) => h.replace(/^www\./, '');
  try {
    if (base(new URL(currentUrl).hostname.toLowerCase()) === base(host)) return false;
  } catch {
    /* no current page */
  }
  return !userText.toLowerCase().includes(base(host));
}

/** Password, payment-card and ID fields: typing into these always needs approval in risky mode. */
export function isSensitiveField(target: Target): boolean {
  return (
    target.type === 'password' ||
    target.autocomplete.startsWith('cc-') ||
    SENSITIVE_FIELD.test(`${target.fieldName} ${target.name}`)
  );
}

/** Passwords, card numbers and the like must never show up in the step log. */
export function maskIfSecret(text: string, target: Target | null): string {
  return target && isSensitiveField(target) ? '•'.repeat(Math.min(text.length, 8)) : text;
}
