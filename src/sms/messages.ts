import type { SmsMessage } from './sender.js';

/**
 * The text message that carries a sign-in code, in Bengali and English. The minutes are written
 * here and must match the lifetime in PhoneAuthProcess. Short on purpose: a long message costs
 * more, and Bengali text is split into more parts than English.
 */
export function codeMessage(context: {
  to: string;
  locale: 'bn' | 'en';
  agencyName: string;
  code: string;
}): SmsMessage {
  const { to, locale, agencyName, code } = context;
  return {
    to,
    text:
      locale === 'bn'
        ? `${agencyName}: আপনার কোড ${code}। ৫ মিনিট কাজ করবে। কাউকে বলবেন না।`
        : `${agencyName}: your code is ${code}. It works for 5 minutes. Do not share it.`,
  };
}
