export async function sendEmail(
  apiKey: string,
  opts: { to: string; subject: string; html: string },
): Promise<void> {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'WokSpec <noreply@wokspec.org>', to: opts.to, subject: opts.subject, html: opts.html }),
  });
}

export function bookingConfirmEmail(email: string): string {
  return `<p>Hi ${email},</p><p>Your WokSpec consultation has been confirmed. We'll be in touch shortly.</p>`;
}
