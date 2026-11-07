import { Mail, MessageCircle, Phone } from "lucide-react";
import type { SchoolContacts as Contacts } from "@/server/messages/announcements";
import { formatPhone } from "@/lib/phone";

const linkClass =
  "flex min-h-11 items-center gap-3 px-4 py-2.5 text-base text-ink hover:bg-subtle focus-visible:bg-subtle";

/** How to reach the school office (PRT-06): call, WhatsApp or email, each one tap on a phone. */
export function SchoolContacts({ contacts, schoolName }: { contacts: Contacts; schoolName: string }) {
  return (
    <section aria-labelledby="contact-school" className="space-y-3">
      <div>
        <h2 id="contact-school" className="text-md font-semibold text-ink">
          Contact the school
        </h2>
        {contacts.officeHours && <p className="text-sm text-ink-3">Office hours: {contacts.officeHours}</p>}
      </div>
      {(contacts.phone || contacts.whatsapp || contacts.email) && (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {contacts.phone && (
            <li>
              <a href={`tel:${contacts.phone}`} className={linkClass}>
                <Phone aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                <span>
                  Call <span className="tabular-nums">{formatPhone(contacts.phone)}</span>
                </span>
              </a>
            </li>
          )}
          {contacts.whatsapp && (
            <li>
              <a
                href={`https://wa.me/${contacts.whatsapp.replace(/\D/g, "")}`}
                className={linkClass}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                <span>
                  WhatsApp <span className="tabular-nums">{formatPhone(contacts.whatsapp)}</span>
                </span>
              </a>
            </li>
          )}
          {contacts.email && (
            <li>
              <a href={`mailto:${contacts.email}`} className={linkClass}>
                <Mail aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                <span className="min-w-0 break-words">
                  Email <span className="sr-only">{schoolName} at </span>
                  {contacts.email}
                </span>
              </a>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
