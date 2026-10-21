import { ErrorNotice } from './primitives';
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { IconDeviceDesktopDown, IconLogout, IconMasksTheater } from "@tabler/icons-react";
import { Check, LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";

import {
  COLLAPSED_SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSE_DRAG_THRESHOLD,
  SIDEBAR_EXPAND_DRAG_THRESHOLD,
} from "../lib/sidebar-geometry";
import {
  clampSidebarWidth,
  loadSidebarCollapsed,
  loadSidebarWidth,
  saveSidebarPreference,
} from "../lib/sidebar-preferences";
import type { WorkspaceMember } from "../lib/types";
import { AccountTrigger } from "./account-trigger";
import { SidebarNavigationRowContent } from "./navigation";
import { IconButton } from "./primitives";
import {
  ResizableSidebar,
  SidebarCollapseFooter,
  SidebarHeader,
  SidebarHorizontalLine,
  SidebarList,
  SidebarRow,
  SidebarScroll,
} from "./resizable-sidebar";

const SIDEBAR_WIDTH_KEY = "sideline.sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "sideline.sidebar-collapsed";

/**
 * Sideline's left rail, built from the same parts as Rally's Spaces sidebar:
 * the resizable shell, a header of actions, navigation rows, and the account
 * footer. It reuses the Spaces sidebar's classes so the two rails stay one
 * design rather than two copies of it.
 */
export function SidelineSidebar(props: {
  currentUser: WorkspaceMember;
  workspaceName: string;
  /** The Organization this session is in. */
  activeOrganizationId: string;
  /** Every Organization the person belongs to; null until the first read answers. */
  organizations: ReadonlyArray<{ id: string; name: string }> | null;
  /** The menu opened: read the Organization list again. */
  onMenuOpen: () => void;
  /** How the switch ended; a rejection means it could not be attempted. */
  onSwitchOrganization: (id: string) => Promise<"switched" | "not_admitted" | "superseded">;
  /** The version waiting to install on restart; the restart controls show only while one is. */
  downloadedUpdate?: string | null;
  onRestartToUpdate?: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const sidebarRef = useRef<HTMLElement>(null);
  // Kept per device, as Rally's own sidebars are, under Sideline's keys.
  const [collapsed, setCollapsedState] = useState(() => loadSidebarCollapsed(SIDEBAR_COLLAPSED_KEY));
  const [width, setWidthState] = useState(() => loadSidebarWidth(SIDEBAR_WIDTH_KEY));
  const setCollapsed = (next: boolean): void => {
    saveSidebarPreference(SIDEBAR_COLLAPSED_KEY, next);
    setCollapsedState(next);
  };
  const setWidth = (next: number): void => {
    const clamped = clampSidebarWidth(next);
    saveSidebarPreference(SIDEBAR_WIDTH_KEY, clamped);
    setWidthState(clamped);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<{ id: string; reason: "not_admitted" | "failed" } | null>(null);
  const effectiveWidth = collapsed ? COLLAPSED_SIDEBAR_WIDTH : width;
  const switchOrganization = (id: string): void => {
    setSwitchingId(id);
    setSwitchError(null);
    props.onSwitchOrganization(id).then(
      (outcome) => {
        if (outcome === "not_admitted") setSwitchError({ id, reason: "not_admitted" });
        else setMenuOpen(false);
      },
      () => setSwitchError({ id, reason: "failed" }),
    ).finally(() => setSwitchingId(null));
  };
  const restart = props.downloadedUpdate && props.onRestartToUpdate
    ? { version: props.downloadedUpdate, run: props.onRestartToUpdate }
    : null;

  const resize = (requested: number): void => {
    if (collapsed) {
      if (requested < SIDEBAR_EXPAND_DRAG_THRESHOLD) return;
      setWidth(requested);
      setCollapsed(false);
      return;
    }
    if (requested < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      setCollapsed(true);
      return;
    }
    setWidth(requested);
  };

  return (
    <Tooltip.Provider>
      <div
        className="sideline-app workspace-shell"
        style={{ "--spaces-sidebar-width": `${effectiveWidth}px` } as React.CSSProperties}
      >
        <ResizableSidebar
          aria-label="Sideline navigation"
          className="spaces-sidebar sideline-sidebar"
          compact={collapsed}
          onResize={resize}
          onToggle={() => setCollapsed(!collapsed)}
          resizeLabel="Resize navigation"
          sidebarRef={sidebarRef}
          width={effectiveWidth}
        >
          <SidebarHeader aria-label="Sideline actions" className="spaces-sidebar-titlebar">
            <div className="spaces-sidebar-titlebar-actions">
              {restart && (
                <IconButton
                  className="spaces-sidebar-update"
                  label={`Restart to update to Sideline ${restart.version}`}
                  onClick={restart.run}
                >
                  <IconDeviceDesktopDown size={16} stroke={1.8} />
                </IconButton>
              )}
            </div>
          </SidebarHeader>
          <SidebarScroll as="nav" aria-label="Sideline">
            <SidebarList>
              <SidebarRow aria-current="page" className="is-active" type="button">
                <SidebarNavigationRowContent
                  icon={<IconMasksTheater aria-hidden="true" size={20} stroke={1.6} />}
                  title="Impersonate"
                />
              </SidebarRow>
            </SidebarList>
          </SidebarScroll>
          <SidebarHorizontalLine className="spaces-sidebar-footer-line" />
          <SidebarCollapseFooter
            collapseLabel="Collapse navigation"
            compact={collapsed}
            expandLabel="Expand navigation"
            leading={(
              <div className="spaces-account-slot">
                <DropdownMenu.Root
                  onOpenChange={(open) => {
                    setMenuOpen(open);
                    if (open) {
                      setSwitchError(null);
                      props.onMenuOpen();
                    }
                  }}
                  open={menuOpen}
                >
                  <DropdownMenu.Trigger asChild>
                    <AccountTrigger currentUser={props.currentUser} workspaceName={props.workspaceName} />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="start"
                      alignOffset={8}
                      className="menu-content workspace-menu"
                      collisionPadding={8}
                      side="top"
                      sideOffset={8}
                    >
                      {restart && (
                        <DropdownMenu.Item className="menu-item account-menu-item" onSelect={restart.run}>
                          <IconDeviceDesktopDown aria-hidden="true" />
                          <span>Restart to Update</span>
                        </DropdownMenu.Item>
                      )}
                      <DropdownMenu.Label className="menu-label workspace-menu-section">Organizations</DropdownMenu.Label>
                      {(props.organizations ?? [{ id: props.activeOrganizationId, name: props.workspaceName }]).map((organization) => {
                        const active = organization.id === props.activeOrganizationId;
                        const switching = organization.id === switchingId;
                        const error = switchError?.id !== organization.id
                          ? null
                          : switchError.reason === "not_admitted"
                            ? "Sideline isn't available in this Organization"
                            : "Couldn't switch. Try again.";
                        return (
                          <DropdownMenu.Item
                            aria-label={[organization.name, ...(active ? ["Current"] : []), ...(error ? [error] : [])].join(", ")}
                            className="menu-item workspace-menu-item"
                            key={organization.id}
                            onSelect={(event) => {
                              if (active) return;
                              // The menu stays open while a switch runs, so the
                              // spinner and any refusal land where the person is looking.
                              event.preventDefault();
                              if (!switchingId) switchOrganization(organization.id);
                            }}
                          >
                            <span aria-hidden="true" className="workspace-mark">{organization.name.slice(0, 1).toLocaleUpperCase()}</span>
                            <span className="workspace-menu-copy">
                              <span>{organization.name}</span>
                              {error && <ErrorNotice>{error}</ErrorNotice>}
                            </span>
                            {switching && <LoaderCircle aria-label="Opening organization" className="spin" size={14} />}
                            {active && <Check aria-label="Current" size={14} />}
                          </DropdownMenu.Item>
                        );
                      })}
                      <DropdownMenu.Separator className="menu-separator account-menu-separator" />
                      <DropdownMenu.Item className="menu-item account-menu-item" onSelect={props.onSignOut}>
                        <IconLogout aria-hidden="true" />
                        <span>Sign out</span>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            )}
            onToggle={() => setCollapsed(!collapsed)}
          />
        </ResizableSidebar>
        <div className="sideline-main">{props.children}</div>
      </div>
    </Tooltip.Provider>
  );
}
