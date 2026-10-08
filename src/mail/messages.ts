import type { MailMessage } from './mailer.js';

/**
 * The emails the sign-in flows send, in Bengali and English. Plain text on purpose: it cannot
 * hide a different link behind the visible words, and it reads the same in every mail app.
 * Hours of validity are written here and must match the lifetimes in AccountAccessProcess.
 */
export type MailLocale = 'bn' | 'en';

interface Context {
  to: string;
  locale: MailLocale;
  agencyName: string;
}

export function verificationEmail(context: Context & { name: string; link: string }): MailMessage {
  const { to, locale, agencyName, name, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার ইমেইল নিশ্চিত করুন`,
        text: [
          `প্রিয় ${name},`,
          '',
          `${agencyName}-এ আপনার অ্যাকাউন্ট তৈরি করতে নিচের লিংকটি খুলুন। লিংকটি ২৪ ঘণ্টা পর্যন্ত কাজ করবে।`,
          '',
          link,
          '',
          'আপনি এটির অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো অ্যাকাউন্ট তৈরি হবে না।',
        ].join('\n'),
      }
    : {
        to,
        subject: `${agencyName}: confirm your email`,
        text: [
          `Dear ${name},`,
          '',
          `Open the link below to create your account at ${agencyName}. It works for 24 hours.`,
          '',
          link,
          '',
          'If you did not ask for this, ignore this email. No account will be created.',
        ].join('\n'),
      };
}

/** Sent instead of a verification link when the address already has an account. */
export function alreadyRegisteredEmail(
  context: Context & { signInLink: string; resetLink: string },
): MailMessage {
  const { to, locale, agencyName, signInLink, resetLink } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার অ্যাকাউন্ট আগে থেকেই আছে`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `কেউ এই ইমেইল দিয়ে ${agencyName}-এ রেজিস্ট্রেশন করার চেষ্টা করেছে, কিন্তু এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে।`,
          '',
          `আপনি নিজে করে থাকলে সাইন ইন করুন: ${signInLink}`,
          `পাসওয়ার্ড ভুলে গেলে: ${resetLink}`,
          '',
          'আপনি না করে থাকলে কিছু করতে হবে না।',
        ].join('\n'),
      }
    : {
        to,
        subject: `${agencyName}: you already have an account`,
        text: [
          'Hello,',
          '',
          `Someone tried to register at ${agencyName} with this email, but it already has an account.`,
          '',
          `If it was you, sign in: ${signInLink}`,
          `If you forgot your password: ${resetLink}`,
          '',
          'If it was not you, you do not need to do anything.',
        ].join('\n'),
      };
}

/** The link that adds this address to the account that asked, sent to the address itself. */
export function addEmailEmail(context: Context & { link: string }): MailMessage {
  const { to, locale, agencyName, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার ইমেইল যোগ করুন`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `${agencyName}-এ আপনার অ্যাকাউন্টে এই ইমেইলটি যোগ করার অনুরোধ পেয়েছি। যোগ করতে নিচের লিংকটি খুলুন। লিংকটি ১ ঘণ্টা কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। কোনো ইমেইল যোগ হবে না।',
        ].join('\n'),
      }
    : {
        to,
        subject: `${agencyName}: add your email`,
        text: [
          'Hello,',
          '',
          `We received a request to add this email to an account at ${agencyName}. Open the link below to add it. It works for 1 hour and only once.`,
          '',
          link,
          '',
          'If you did not ask for this, ignore this email. Nothing will be added.',
        ].join('\n'),
      };
}

/** Sent instead of the link when the address already belongs to an account. */
export function emailInUseNotice(context: Context & { signInLink: string }): MailMessage {
  const { to, locale, agencyName, signInLink } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: এই ইমেইল আগে থেকেই ব্যবহার হচ্ছে`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `কেউ ${agencyName}-এ অন্য একটি অ্যাকাউন্টে এই ইমেইল যোগ করার চেষ্টা করেছে, কিন্তু এই ইমেইলে আগে থেকেই একটি অ্যাকাউন্ট আছে।`,
          '',
          `সাইন ইন করতে: ${signInLink}`,
          '',
          'আপনি না করে থাকলে কিছু করতে হবে না।',
        ].join('\n'),
      }
    : {
        to,
        subject: `${agencyName}: this email is already in use`,
        text: [
          'Hello,',
          '',
          `Someone tried to add this email to another account at ${agencyName}, but it already belongs to an account.`,
          '',
          `To sign in: ${signInLink}`,
          '',
          'If it was not you, you do not need to do anything.',
        ].join('\n'),
      };
}

export function passwordResetEmail(context: Context & { link: string }): MailMessage {
  const { to, locale, agencyName, link } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: পাসওয়ার্ড রিসেট`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `আপনার ${agencyName} পাসওয়ার্ড বদলানোর অনুরোধ পেয়েছি। নতুন পাসওয়ার্ড দিতে নিচের লিংকটি খুলুন। লিংকটি ১ ঘণ্টা কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
          '',
          link,
          '',
          'আপনি অনুরোধ না করে থাকলে এই ইমেইলটি উপেক্ষা করুন। আপনার পাসওয়ার্ড বদলাবে না।',
        ].join('\n'),
      }
    : {
        to,
        subject: `${agencyName}: reset your password`,
        text: [
          'Hello,',
          '',
          `We received a request to change your ${agencyName} password. Open the link below to choose a new one. It works for 1 hour and only once.`,
          '',
          link,
          '',
          'If you did not ask for this, ignore this email. Your password will not change.',
        ].join('\n'),
      };
}

export function passwordChangedEmail(context: Context & { resetLink: string }): MailMessage {
  const { to, locale, agencyName, resetLink } = context;
  return locale === 'bn'
    ? {
        to,
        subject: `${agencyName}: আপনার পাসওয়ার্ড বদলানো হয়েছে`,
        text: [
          'প্রিয় ব্যবহারকারী,',
          '',
          `আপনার ${agencyName} পাসওয়ার্ড এইমাত্র বদলানো হয়েছে এবং সব ডিভাইস থেকে সাইন আউট করা হয়েছে।`,
          '',
          `আপনি এটি না করে থাকলে এখনই পাসওয়ার্ড রিসেট করুন: ${resetLink}`,
          'এবং এজেন্সির সঙ্গে যোগাযোগ করুন।',
        ].join('\n'),
      }
    : {
        to,
        subject: `${agencyName}: your password was changed`,
        text: [
          'Hello,',
          '',
          `Your ${agencyName} password was just changed, and every device was signed out.`,
          '',
          `If this was not you, reset your password now: ${resetLink}`,
          'and contact the agency.',
        ].join('\n'),
      };
}
