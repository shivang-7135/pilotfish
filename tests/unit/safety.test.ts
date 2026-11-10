import { describe, expect, it } from 'vitest';
import { maskIfSecret, needsConfirmation, needsNavigationApproval } from '../../lib/safety';
import type { Target } from '../../lib/page';

const target = (over: Partial<Target>): Target => ({
  x: 0,
  y: 0,
  covered: false,
  tag: 'button',
  type: '',
  name: '',
  desc: '',
  autocomplete: '',
  fieldName: '',
  isSearch: false,
  inForm: false,
  formHasPassword: false,
  editable: false,
  readonly: false,
  nativePicker: false,
  ...over,
});
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: '1', name, args });

describe('needsConfirmation (risky mode)', () => {
  it.each(['Place order', 'Pay now', 'Send message', 'Delete account', 'Jetzt kaufen', 'Absenden', 'Sign up'])(
    'asks before clicking "%s"',
    (name) => {
      expect(needsConfirmation('risky', call('click'), target({ name }), 'x')).toBeTruthy();
    },
  );

  it.each(['Next', 'Show more', 'Postcode lookup', 'Bookmarks', 'Reorder columns'])('does not ask for "%s"', (name) => {
    expect(needsConfirmation('risky', call('click'), target({ name }), 'x')).toBeNull();
  });

  it('asks before clicking any submit control', () => {
    expect(needsConfirmation('risky', call('click'), target({ name: 'Go', type: 'submit' }), 'x')).toBeTruthy();
  });

  it('does not ask for ticking a checkbox, whatever its label', () => {
    const box = target({ tag: 'input', type: 'checkbox', name: 'I agree to the terms' });
    expect(needsConfirmation('risky', call('click'), box, 'x')).toBeNull();
  });

  it('asks before typing into password and card fields', () => {
    expect(needsConfirmation('risky', call('type'), target({ type: 'password' }), 'x')).toBeTruthy();
    expect(needsConfirmation('risky', call('type'), target({ autocomplete: 'cc-number' }), 'x')).toBeTruthy();
    expect(needsConfirmation('risky', call('type'), target({ name: 'First name' }), 'x')).toBeNull();
  });

  it('lets search boxes submit but not other forms', () => {
    expect(needsConfirmation('risky', call('type', { submit: true }), target({ isSearch: true }), 'x')).toBeNull();
    expect(needsConfirmation('risky', call('type', { submit: true }), target({}), 'x')).toBeTruthy();
  });
});

describe('ways around the click check', () => {
  it('asks before Enter in a form field, but not in a search box or outside a form', () => {
    const enter = call('press_key', { key: 'Enter' });
    expect(needsConfirmation('risky', enter, target({ tag: 'input', type: 'text', inForm: true }), 'x')).toBeTruthy();
    expect(needsConfirmation('risky', enter, target({ tag: 'input', type: 'search', inForm: true, isSearch: true }), 'x')).toBeNull();
    expect(needsConfirmation('risky', enter, target({ tag: 'input', type: 'text' }), 'x')).toBeNull();
  });

  it('asks before Enter or Space on a focused button that commits', () => {
    const pay = target({ tag: 'button', type: 'submit', name: 'Pay now', inForm: true });
    expect(needsConfirmation('risky', call('press_key', { key: 'Enter' }), pay, 'x')).toBeTruthy();
    expect(needsConfirmation('risky', call('press_key', { key: 'Space' }), pay, 'x')).toBeTruthy();
    expect(needsConfirmation('risky', call('press_key', { key: 'Tab' }), pay, 'x')).toBeNull();
  });

  it('reads the description when a button has no proper name', () => {
    const icon = target({ tag: 'div', name: '', desc: 'clickable "pay now button"' });
    expect(needsConfirmation('risky', call('click'), icon, 'x')).toBeTruthy();
  });

  it.each(['Jetzt zahlen', 'Cancel subscription', 'Abo kündigen'])('asks before clicking "%s"', (name) => {
    expect(needsConfirmation('risky', call('click'), target({ name }), 'x')).toBeTruthy();
  });

  it('does not ask for a plain Cancel button', () => {
    expect(needsConfirmation('risky', call('click'), target({ name: 'Cancel' }), 'x')).toBeNull();
  });
});

describe('needsNavigationApproval', () => {
  const here = 'https://shop.example.com/cart';
  it('allows the same site and sites the user named', () => {
    expect(needsNavigationApproval('https://www.shop.example.com/pay', here, 'buy it')).toBe(false);
    expect(needsNavigationApproval('wikipedia.org/wiki/Ada', here, 'look her up on Wikipedia.org')).toBe(false);
  });
  it('asks for any other site, and for URLs it cannot read', () => {
    expect(needsNavigationApproval('https://evil.test/?d=secret', here, 'fill this form')).toBe(true);
    expect(needsNavigationApproval('http://', here, 'fill this form')).toBe(true);
  });
});

describe('other modes', () => {
  it('always: asks for every action that changes something, never for reading', () => {
    expect(needsConfirmation('always', call('click'), target({ name: 'Next' }), 'x')).toBeTruthy();
    expect(needsConfirmation('always', call('read_page'), null, 'x')).toBeNull();
  });
  it('never: asks for nothing', () => {
    expect(needsConfirmation('never', call('click'), target({ name: 'Pay now' }), 'x')).toBeNull();
  });
});

it('masks password text in labels', () => {
  expect(maskIfSecret('hunter2', target({ type: 'password' }))).toBe('•••••••');
  expect(maskIfSecret('4111111111111111', target({ autocomplete: 'cc-number' }))).toBe('••••••••');
  expect(maskIfSecret('hello', target({}))).toBe('hello');
});
