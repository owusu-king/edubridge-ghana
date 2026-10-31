"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { ShellIdentity } from "./menus";
import { areaTitle, type ShellArea } from "./navigation";
import { SidebarNav } from "./sidebar-nav";

export function MobileNav({ area }: { area: ShellArea }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="-ml-1.5 inline-flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-subtle hover:text-ink">
        <Menu aria-hidden="true" className="size-5" />
        <span className="sr-only">Open navigation</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-canvas p-3 shadow-overlay focus:outline-none">
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <Dialog.Description className="sr-only">
            Move between areas of {areaTitle(area)}.
          </Dialog.Description>
          <div className="mb-4 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <ShellIdentity area={area} />
            </div>
            <Dialog.Close className="inline-flex size-9 items-center justify-center rounded-md text-ink-2 hover:bg-subtle hover:text-ink">
              <X aria-hidden="true" className="size-5" />
              <span className="sr-only">Close navigation</span>
            </Dialog.Close>
          </div>
          <SidebarNav area={area} onNavigate={() => setOpen(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
