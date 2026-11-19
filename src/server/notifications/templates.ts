/**
 * Message templates. Plain, readable, and free of tracking. Medical, safeguarding and statement details
 * never go into SMS (a fee reminder carries only the balance owed); links carry single-use tokens only.
 */
import {
  absenceAlertSms,
  announcementSms,
  consentRequestSms,
  eventReminderSms,
  feeReminderSms,
  feesBilledSms,
  paymentReceiptSms,
  portalInvitationSms,
} from "@/lib/fee-messages";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Push only: the page a notification opens (a path on this site). */
  url?: string;
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

export function appUrl(path: string): string {
  const origin = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${origin}${path}`;
}

/** The address of a balance link (short: it goes in an SMS). */
export function balanceLinkUrl(token: string): string {
  return appUrl(`/b/${token}`);
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

  /**
   * An EduBridge invoice to a school (SUB-03). The PDF is not attached: it is downloaded after signing in
   * (Settings, Plan), so a forwarded or intercepted email carries no invoice.
   */
  subscription_invoice(payload: {
    schoolName: string;
    schoolSlug: string;
    invoiceNumber: string;
    total: string;
    dueOn: string;
  }): RenderedEmail {
    const url = appUrl(`/s/${encodeURIComponent(payload.schoolSlug)}/settings/plan`);
    const lines = [
      `EduBridge has issued invoice ${payload.invoiceNumber} to ${payload.schoolName} for ${payload.total}, due on ${payload.dueOn}.`,
      "Sign in to see it and download the PDF, with how to pay, under Settings, Plan.",
    ];
    return {
      subject: `EduBridge invoice ${payload.invoiceNumber}`,
      html: layout(`Invoice ${payload.invoiceNumber}`, lines, { label: "See the invoice", url }),
      text: `${lines.join("\n\n")}\n\nSee the invoice: ${url}\n`,
    };
  },

  /** An open EduBridge invoice falls due in a week (sent once). */
  subscription_invoice_due_soon(payload: {
    schoolName: string;
    schoolSlug: string;
    invoiceNumber: string;
    total: string;
    dueOn: string;
  }): RenderedEmail {
    const url = appUrl(`/s/${encodeURIComponent(payload.schoolSlug)}/settings/plan`);
    const lines = [
      `A reminder that EduBridge invoice ${payload.invoiceNumber} for ${payload.schoolName}, ${payload.total}, is due on ${payload.dueOn}.`,
      "You can pay it online or see how to pay under Settings, Plan. If you have already paid, thank you.",
    ];
    return {
      subject: `EduBridge invoice ${payload.invoiceNumber} is due on ${payload.dueOn}`,
      html: layout("Invoice due soon", lines, { label: "See the invoice", url }),
      text: `${lines.join("\n\n")}\n\nSee the invoice: ${url}\n`,
    };
  },

  /** An EduBridge invoice has passed its due date (sent once). */
  subscription_invoice_overdue(payload: {
    schoolName: string;
    schoolSlug: string;
    invoiceNumber: string;
    total: string;
    dueOn: string;
  }): RenderedEmail {
    const url = appUrl(`/s/${encodeURIComponent(payload.schoolSlug)}/settings/plan`);
    const lines = [
      `EduBridge invoice ${payload.invoiceNumber} for ${payload.schoolName}, ${payload.total}, was due on ${payload.dueOn} and is not paid yet.`,
      "Everything keeps working for a short grace period. After that, SMS to families are paused until it is paid; nothing else stops.",
      "If you have already paid, please reply with the reference so EduBridge can record it.",
    ];
    return {
      subject: `EduBridge invoice ${payload.invoiceNumber} is overdue`,
      html: layout("Invoice overdue", lines, { label: "See the invoice", url }),
      text: `${lines.join("\n\n")}\n\nSee the invoice: ${url}\n`,
    };
  },

  /** A school's subscription status changed automatically (SUB-05): trial or paid period ended, or paid again. */
  subscription_status(payload: {
    schoolName: string;
    schoolSlug: string;
    status: "active" | "grace" | "past_due";
  }): RenderedEmail {
    const url = appUrl(`/s/${encodeURIComponent(payload.schoolSlug)}/settings/plan`);
    const lines =
      payload.status === "active"
        ? [`Thank you. ${payload.schoolName}'s EduBridge subscription is active again.`]
        : payload.status === "grace"
          ? [
              `${payload.schoolName}'s EduBridge trial or paid period has ended. Everything keeps working for a short grace period.`,
              "To continue without interruption, pay the open invoice or contact EduBridge.",
            ]
          : [
              `${payload.schoolName}'s EduBridge subscription is overdue. SMS to families are paused; everything else keeps working.`,
              "SMS resume as soon as the subscription is paid.",
            ];
    const heading =
      payload.status === "active"
        ? "Subscription active"
        : payload.status === "grace"
          ? "Grace period"
          : "Payment overdue";
    return {
      subject: `${payload.schoolName}: ${heading.toLowerCase()}`,
      html: layout(heading, lines, { label: "See your plan", url }),
      text: `${lines.join("\n\n")}\n\nSee your plan: ${url}\n`,
    };
  },

  /** To EduBridge's platform staff: a school asked to change its plan (SUB-02). */
  plan_change_requested(payload: {
    schoolName: string;
    tenantId: string;
    requestedBy: string;
    what: string;
  }): RenderedEmail {
    const url = appUrl("/admin/plans");
    const lines = [
      `${payload.requestedBy} at ${payload.schoolName} asked to change the school's plan: ${payload.what}`,
    ];
    return {
      subject: `Plan change request: ${payload.schoolName}`,
      html: layout("Plan change request", lines, { label: "Decide it", url }),
      text: `${lines.join("\n\n")}\n\nDecide it: ${url}\n`,
    };
  },

  /** To the member who asked: EduBridge approved or declined the plan change. */
  plan_change_decided(payload: {
    schoolName: string;
    schoolSlug: string;
    approved: boolean;
    planName: string;
    note: string | null;
    /** For a module request (SUB-08): what was asked, e.g. "Add Transport". */
    what?: string | null;
  }): RenderedEmail {
    const url = appUrl(`/s/${encodeURIComponent(payload.schoolSlug)}/settings/plan`);
    const lines = [
      payload.what
        ? payload.approved
          ? `EduBridge approved ${payload.schoolName}'s request: ${payload.what}.`
          : `EduBridge did not approve ${payload.schoolName}'s request: ${payload.what}.`
        : payload.approved
          ? `EduBridge approved ${payload.schoolName}'s plan change. The school is now on the ${payload.planName} plan.`
          : `EduBridge did not make the plan change ${payload.schoolName} asked for.`,
      ...(payload.note ? [`Note from EduBridge: ${payload.note}`] : []),
    ];
    return {
      subject: payload.approved ? "Your plan change was approved" : "About your plan change request",
      html: layout(payload.approved ? "Plan changed" : "Plan change request", lines, {
        label: "See your plan",
        url,
      }),
      text: `${lines.join("\n\n")}\n\nSee your plan: ${url}\n`,
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

  /** Confirms the phone on an online application (ADM-02); only the code and the school's name. */
  application_code(payload: { schoolName: string; code: string }): RenderedEmail {
    return {
      subject: "",
      html: "",
      text: `${payload.schoolName}: your application code is ${payload.code}. It expires in 15 minutes.`,
    };
  },

  /** To the family when a payment is recorded, if the school turned it on. */
  payment_receipt(payload: {
    /** The school's currency; older queued messages have none (GHS). */
    currency?: string;
    schoolName: string;
    studentFirstName: string;
    amountPesewas: number;
    receiptNumber: string;
    balancePesewas: number;
    /** Set for messages queued since FIN-11: the parent-view receipt address. */
    schoolSlug?: string;
  }): RenderedEmail {
    const link = payload.schoolSlug
      ? appUrl(`/p/${payload.schoolSlug}/r/${payload.receiptNumber}`)
      : undefined;
    return { subject: "", html: "", text: paymentReceiptSms({ ...payload, link }) };
  },

  /** To the family when a term is billed and the school asked to tell families (COM-01). */
  fees_billed(payload: {
    /** The school's currency; older queued messages have none (GHS). */
    currency?: string;
    schoolName: string;
    studentFirstName: string;
    termLabel: string;
    balancePesewas: number;
  }): RenderedEmail {
    return { subject: "", html: "", text: feesBilledSms({ ...payload, link: appUrl("/p") }) };
  },

  /** A school invites a guardian to the parent view (PAR-01). */
  portal_invitation(payload: { schoolName: string; studentFirstName: string }): RenderedEmail {
    return { subject: "", html: "", text: portalInvitationSms({ ...payload, link: appUrl("/p") }) };
  },

  /**
   * A web push about a new announcement (PSH-02): only that there is one, from which school. The title and
   * text are read in the parent view after sign-in, so nothing private shows on a locked phone.
   */
  announcement_push(payload: { schoolName: string; schoolSlug: string }): RenderedEmail {
    return {
      subject: payload.schoolName,
      html: "",
      text: "A new announcement. Open to read it.",
      url: `/p/${encodeURIComponent(payload.schoolSlug)}/news`,
    };
  },

  /** To admissions staff (PSH-01): a family applied online; the details open after sign-in. */
  staff_application_push(payload: { schoolName: string; schoolSlug: string }): RenderedEmail {
    return {
      subject: payload.schoolName,
      html: "",
      text: "A new online application. Open to see it.",
      url: `/s/${encodeURIComponent(payload.schoolSlug)}/admissions?status=applied`,
    };
  },

  /** A consent form needs an answer (CNS-01): which school only; the form is read after sign-in. */
  consent_push(payload: { schoolName: string }): RenderedEmail {
    return {
      subject: payload.schoolName,
      html: "",
      text: "A form needs your answer. Open to see it.",
      url: "/p",
    };
  },

  /** A reminder before an event (EVT-01): which school only; the event is read after sign-in. */
  event_push(payload: { schoolName: string; schoolSlug: string }): RenderedEmail {
    return {
      subject: payload.schoolName,
      html: "",
      text: "A reminder about a school event. Open to see it.",
      url: `/p/${encodeURIComponent(payload.schoolSlug)}/events`,
    };
  },

  /** A child boarded or got off the school bus (TRN-03b): which school only; the details open after sign-in. */
  transport_push(payload: { schoolName: string; schoolSlug: string; studentId: string }): RenderedEmail {
    return {
      subject: payload.schoolName,
      html: "",
      text: "A school bus update. Open to see it.",
      url: `/p/${encodeURIComponent(payload.schoolSlug)}/${encodeURIComponent(payload.studentId)}`,
    };
  },

  consent_request(payload: { schoolName: string; title: string; deadline: string }): RenderedEmail {
    return { subject: "", html: "", text: consentRequestSms({ ...payload, link: appUrl("/p") }) };
  },

  event_reminder(payload: {
    schoolName: string;
    title: string;
    when: string;
    location?: string | null;
  }): RenderedEmail {
    return { subject: "", html: "", text: eventReminderSms(payload) };
  },

  /** A school announcement: title and a link to the parent view, where it is read in full. */
  announcement(payload: { schoolName: string; title: string }): RenderedEmail {
    return { subject: "", html: "", text: announcementSms({ ...payload, link: appUrl("/p") }) };
  },

  /** To a family after a run of absences or a term total (the school's settings); no reasons. */
  absence_alert(payload: {
    schoolName: string;
    studentFirstName: string;
    days: number;
    kind: "consecutive" | "term_total";
  }): RenderedEmail {
    return { subject: "", html: "", text: absenceAlertSms(payload) };
  },

  /** A polite fee reminder to a guardian, with the balance when it was sent and a 7-day balance link. */
  fee_reminder(payload: {
    /** The school's currency; older queued messages have none (GHS). */
    currency?: string;
    schoolName: string;
    studentFirstName: string;
    balancePesewas?: number;
    balanceLinkToken?: string;
  }): RenderedEmail {
    const link = payload.balanceLinkToken ? balanceLinkUrl(payload.balanceLinkToken) : undefined;
    return { subject: "", html: "", text: feeReminderSms({ ...payload, link }) };
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
