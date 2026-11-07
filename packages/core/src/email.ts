import { EmailClient } from '@azure/communication-email';
import type { CoreConfig } from './config.js';
import { getCredential } from './credential.js';
import { escapeHtml } from './text.js';

export interface MailMessage {
  to: string[];
  subject: string;
  /** Plain text body; the HTML version is generated from it. */
  text: string;
  /** Optional call-to-action button. */
  action?: { label: string; url: string };
  /** Optional unsubscribe link, added to the footer. */
  unsubscribeUrl?: string;
  replyTo?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

function renderHtml(msg: MailMessage): string {
  const paras = msg.text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const button = msg.action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(msg.action.url)}" style="background:#00A0FB;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(msg.action.label)}</a></p>`
    : '';
  const unsub = msg.unsubscribeUrl
    ? `<p style="font-size:12px;color:#8094AA">You receive this because you subscribed to Tungsten Demo Center updates. <a href="${escapeHtml(msg.unsubscribeUrl)}" style="color:#8094AA">Unsubscribe</a>.</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#FAFAFA;font-family:'Segoe UI',Arial,sans-serif;color:#231F20">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#002854;color:#fff;padding:18px 28px;font-size:18px;font-weight:700;letter-spacing:.5px">TUNGSTEN DEMO CENTER</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.5">${paras}${button}${unsub}</td></tr>
</table></td></tr></table></body></html>`;
}

class AcsMailer implements Mailer {
  private readonly client: EmailClient;
  constructor(private readonly config: CoreConfig) {
    this.client = new EmailClient(config.acsEndpoint!, getCredential(config));
  }
  async send(msg: MailMessage) {
    // One message per recipient so addresses are never disclosed to each other.
    for (const to of msg.to) {
      const headers: Record<string, string> = {};
      if (msg.unsubscribeUrl) headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
      const poller = await this.client.beginSend({
        senderAddress: this.config.mailFrom!,
        recipients: { to: [{ address: to }] },
        replyTo: msg.replyTo ? [{ address: msg.replyTo }] : undefined,
        content: {
          subject: msg.subject,
          plainText: msg.text + (msg.action ? `\n\n${msg.action.label}: ${msg.action.url}` : '') + (msg.unsubscribeUrl ? `\n\nUnsubscribe: ${msg.unsubscribeUrl}` : ''),
          html: renderHtml(msg),
        },
        headers,
      });
      await poller.pollUntilDone();
    }
  }
}

/** Development mailer: logs instead of sending. */
class ConsoleMailer implements Mailer {
  async send(msg: MailMessage) {
    console.info(`[mail] to=${msg.to.length} recipient(s) subject="${msg.subject}"${msg.action ? ` action=${msg.action.url}` : ''}`);
  }
}

export function createMailer(config: CoreConfig): Mailer {
  return config.acsEndpoint && config.mailFrom ? new AcsMailer(config) : new ConsoleMailer();
}
