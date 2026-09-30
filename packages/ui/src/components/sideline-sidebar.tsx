import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tooltip from "@radix-ui/react-tooltip";
import { IconDeviceDesktopDown, IconLogout, IconMasksTheater } from "@tabler/icons-react";
import { useRef, useState } from "react";

import {
  COLLAPSED_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_COLLAPSE_DRAG_THRESHOLD,
  SIDEBAR_EXPAND_DRAG_THRESHOLD,
} from "../lib/sidebar-geometry";
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

/**
 * Sideline's left rail, built from the same parts as Rally's Spaces sidebar:
 * the resizable shell, a header of actions, navigation rows, and the account
 * footer. It reuses the Spaces sidebar's classes so the two rails stay one
 * design rather than two copies of it.
 */
export function SidelineSidebar(props: {
  currentUser: WorkspaceMember;
  workspaceName: string;
  /** The version waiting to install on restart; the restart controls show only while one is. */
  downloadedUpdate?: string | null;
  onRestartToUpdate?: () => void;
  onSignOut: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const sidebarRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const effectiveWidth = collapsed ? COLLAPSED_SIDEBAR_WIDTH : width;
  const restart = props.downloadedUpdate && props.onRestartToUpdate
    ? { version: props.downloadedUpdate, run: props.onRestartToUpdate }
    : null;

  const resize = (requested: number): void => {
    if (collapsed) {
      if (requested < SIDEBAR_EXPAND_DRAG_THRESHOLD) return;
      setWidth(Math.min(MAX_SIDEBAR_WIDTH, requested));
      setCollapsed(false);
      return;
    }
    if (requested < SIDEBAR_COLLAPSE_DRAG_THRESHOLD) {
      setCollapsed(true);
      return;
    }
    setWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, requested)));
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
                <DropdownMenu.Root>
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
