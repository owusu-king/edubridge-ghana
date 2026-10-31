/**
 * Message templates. Plain, readable, and free of tracking. Sensitive data (balances, medical details)
 * never goes into SMS; links carry single-use tokens only.
 */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function layout(heading: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escape(p)}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${escape(action.url)}" style="display:inline-block;background:#1b1a17;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escape(action.label)}</a></p><p style="margin:0 0 16px;color:#6b6860;font-size:13px">Or copy this link: ${escape(action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f7f6f3;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1a17;font-size:15px;line-height:1.5"><div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e1db;border-radius:8px;padding:32px"><p style="margin:0 0 24px;font-family:Georgia,serif;font-size:18px;font-weight:600">EduBridge</p><h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:22px;font-weight:500">${escape(heading)}</h1>${body}${button}</div></body></html>`;
}

function appUrl(path: string): string {
  const origin = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${origin}${path}`;
}

export const TEMPLATES = {
  invitation(payload: {
    schoolName: string;
    roles: string[];
    token: string;
    expiresAt: string;
  }): RenderedEmail {
    const url = appUrl(`/invite/${payload.token}`);
    const expires = new Intl.DateTimeFormat("en-GH", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(payload.expiresAt));
    const roles = payload.roles.join(", ");
    const lines = [
      `You have been invited to join ${payload.schoolName} on EduBridge as ${roles}.`,
      `This link works once and expires on ${expires}. If you were not expecting this invitation, you can ignore this email.`,
    ];
    return {
      subject: `Your invitation to ${payload.schoolName}`,
      html: layout(`Join ${payload.schoolName}`, lines, { label: "Accept invitation", url }),
      text: `${lines.join("\n\n")}\n\nAccept the invitation: ${url}\n`,
    };
  },

  password_reset(payload: { name: string; token: string; expiresMinutes: number }): RenderedEmail {
    const url = appUrl(`/reset-password/${payload.token}`);
    const lines = [
      `Hello ${payload.name},`,
      `Someone asked to reset the password for your EduBridge account. The link works once and expires in ${payload.expiresMinutes} minutes.`,
      "If this was not you, ignore this email. Your password stays the same.",
    ];
    return {
      subject: "Reset your EduBridge password",
      html: layout("Reset your password", lines, { label: "Choose a new password", url }),
      text: `${lines.join("\n\n")}\n\nReset your password: ${url}\n`,
    };
  },

  // SMS templates: short, no personal details beyond what the recipient already knows.
  phone_code(payload: { code: string }): RenderedEmail {
    return {
      subject: "",
      html: "",
      text: `EduBridge code: ${payload.code}. It expires in 10 minutes. Never share it.`,
    };
  },

  password_reset_sms(payload: { token: string; expiresMinutes: number }): RenderedEmail {
    const url = appUrl(`/reset-password/${payload.token}`);
    return {
      subject: "",
      html: "",
      text: `EduBridge: reset your password at ${url} (expires in ${payload.expiresMinutes} min). Ignore if you did not ask.`,
    };
  },
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export function isTemplate(name: string): name is TemplateName {
  return name in TEMPLATES;
}
