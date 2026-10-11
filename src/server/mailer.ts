import { env } from '~/env';
import type { SessionUser as User } from '~/server/auth';
import { bindings } from '~/server/db';

import { sendToDiscord } from './service-notification';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export async function sendInviteEmail(email: string, name: string) {
  if (!env.ENABLE_SENDING_INVITES) {
    throw new Error('Sending invites is not enabled');
  }

  const url = env.NEXTAUTH_URL;
  const { host } = new URL(url);
  const safeName = escapeHtml(name);

  const subject = 'Invitation to SplitPro';
  const text = `Hey,\n\nYou have been invited to SplitPro by ${name}. It's a completely open source free alternative to splitwise. You can sign in to SplitPro by clicking the below URL:\n${url}\n\nThanks,\nSplitPro Team`;
  const html = `<p>Hey,</p> <p>You have been invited to SplitPro by ${safeName}. It's a completely open source free alternative to splitwise. You can sign in to SplitPro by clicking the below URL:</p><p><a href="${url}">Sign in to ${host}</a></p><br><p>Thanks,<br/>SplitPro Team</p>`;

  await sendMail(email, subject, text, html);
}

export async function sendFeedbackEmail(feedback: string, user: User) {
  console.log('Received feedback from: ', user.email, 'Feedback: ', feedback);

  if (!env.FEEDBACK_EMAIL) {
    return;
  }

  const subject = `Feedback received on SplitPro from ${user.name}`;
  const text = `Feedback created by ${user.name} :\n\nFeedback: ${feedback}\n\nemail: ${user.email}`;

  await sendMail(env.FEEDBACK_EMAIL, subject, text, escapeHtml(text), user.email ?? undefined);
}

/** Sends through the Cloudflare Email Sending binding (`send_email` → EMAIL). */
async function sendMail(to: string, subject: string, text: string, html: string, replyTo?: string) {
  const mailer = bindings.EMAIL;
  if (!mailer || !env.FROM_EMAIL) {
    console.log('Email binding or FROM_EMAIL not configured, so skipping');
    return false;
  }

  try {
    await mailer.send({
      to,
      from: { email: env.FROM_EMAIL, name: 'SplitPro' },
      subject,
      text,
      html,
      ...(replyTo && { replyTo }),
    });
    console.log('Email sent');
    return true;
  } catch (error) {
    console.log('Error sending email', error);
    await sendToDiscord(
      `Error sending email: ${
        error instanceof Error
          ? `error.message: ${error.message}\nerror.stack: ${error.stack}`
          : 'Unknown error'
      }`,
    );
  }

  return false;
}
