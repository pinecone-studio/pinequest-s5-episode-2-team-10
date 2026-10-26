"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  folderSnapshot,
  folderStoreIsReady,
  folderStoreMigrationError,
  folderStoreMigrationPending,
  retryFolderStore,
  removeFolder,
  renameFolder,
  serverFolderSnapshot,
  subscribeFolders,
  type FolderMeta,
} from "@/lib/folderStore";
import { useLang } from "@/lib/i18nClient";
import Modal from "./Modal";

const MENU_WIDTH = 168;

/**
 * "Pitches" in the sidebar: a button that shows or hides the list, each pitch linking to it, and
 * a ⋯ menu per pitch to rename or delete it.
 */
export default function SidebarPitches({
  home,
  openId,
  onNavigate,
}: {
  /** On the pitch page (where ?folder= opens a pitch). */
  home: boolean;
  /** The pitch open now, if any. */
  openId: string | null;
  /** Called when a link is followed (closes the phone menu). */
  onNavigate: () => void;
}) {
  const { tr } = useLang();
  const router = useRouter();
  const listId = useId();
  const folders = useSyncExternalStore(subscribeFolders, folderSnapshot, serverFolderSnapshot);
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState<{ folder: FolderMeta; top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState<FolderMeta | null>(null);
  const [draft, setDraft] = useState("");
  const [deleting, setDeleting] = useState<FolderMeta | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The menu closes on Escape, a click elsewhere, or scrolling (it is placed where its button was).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onPointer(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    menuRef.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  function openMenu(folder: FolderMeta, button: HTMLButtonElement) {
    if (menu?.folder.id === folder.id) return setMenu(null);
    const rect = button.getBoundingClientRect();
    setMenu({ folder, top: rect.bottom + 4, left: Math.max(8, rect.right - MENU_WIDTH) });
  }

  function startRename(folder: FolderMeta) {
    setMenu(null);
    setDraft(folder.name);
    setRenaming(folder);
  }

  function saveRename(e: React.FormEvent) {
    e.preventDefault();
    if (renaming && draft.trim()) renameFolder(renaming.id, draft);
    setRenaming(null);
  }

  async function confirmDelete() {
    const folder = deleting;
    setDeleting(null);
    if (!folder) return;
    if (openId === folder.id) router.push("/");
    await removeFolder(folder);
  }

  return (
    <>
      <button
        type="button"
        className="app-nav-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
      >
        <PitchIcon />
        <span className="app-nav-label">{tr("folders")}</span>
        {folders.length > 0 && <span className="app-nav-count">{folders.length}</span>}
        <span className={open ? "app-nav-chevron is-open" : "app-nav-chevron"}>
          <ChevronIcon />
        </span>
      </button>
      {open && folders.length > 0 && (
        <ul id={listId} className="app-nav-folders">
          {folders.map((folder) => {
            const current = home && openId === folder.id;
            const menuOpen = menu?.folder.id === folder.id;
            return (
              <li key={folder.id} className={menuOpen ? "is-menu-open" : undefined}>
                <Link
                  href={`/?folder=${encodeURIComponent(folder.id)}`}
                  aria-current={current ? "page" : undefined}
                  title={folder.name}
                  onClick={onNavigate}
                >
                  {folder.name}
                </Link>
                <button
                  type="button"
                  className="app-nav-more"
                  aria-label={tr("pitchActions", { name: folder.name })}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={(e) => openMenu(folder, e.currentTarget)}
                >
                  <MoreIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {open && folders.length === 0 && !folderStoreIsReady() && (
        <div className="app-nav-loading-skeleton" role="status" aria-label={tr("foldersLoading")} aria-busy="true">
          {[68, 82, 56].map((width, index) => (
            <span key={index} className="app-nav-skeleton-line" style={{ width: `${width}%` }} />
          ))}
        </div>
      )}
      {open && folderStoreMigrationPending() && (
        <p className="app-nav-loading" role="status">{tr("foldersMigrating")}</p>
      )}
      {open && folderStoreMigrationError() && (
        <p className="app-nav-loading" role="status">
          {tr("foldersMigrationFailed")}{" "}
          <button type="button" onClick={() => void retryFolderStore()}>{tr("folderSyncRetry")}</button>
        </p>
      )}

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            className="app-nav-menu"
            role="menu"
            aria-label={tr("pitchActions", { name: menu.folder.name })}
            style={{ top: menu.top, left: menu.left, width: MENU_WIDTH }}
          >
            <button type="button" role="menuitem" onClick={() => startRename(menu.folder)}>
              {tr("renamePitch")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              onClick={() => {
                setDeleting(menu.folder);
                setMenu(null);
              }}
            >
              {tr("deleteFolder")}
            </button>
          </div>,
          document.body,
        )}

      {renaming &&
        createPortal(
          <Modal title={tr("renamePitch")} onClose={() => setRenaming(null)}>
            <form onSubmit={saveRename} className="desk-panel">
              <label>
                <span>{tr("folderName")}</span>
                <input type="text" autoFocus value={draft} maxLength={120} onChange={(e) => setDraft(e.target.value)} />
              </label>
              <div className="app-modal-actions folder-delete-actions">
                <button type="button" className="ui-btn" onClick={() => setRenaming(null)}>
                  {tr("cancel")}
                </button>
                <button type="submit" className="desk-primary" disabled={!draft.trim()}>
                  {tr("figmaSave")}
                </button>
              </div>
            </form>
          </Modal>,
          document.body,
        )}

      {deleting &&
        createPortal(
          <Modal title={tr("deleteFolderTitle", { name: deleting.name })} onClose={() => setDeleting(null)}>
            <p className="folder-delete-text">{tr("deleteFolderText")}</p>
            <div className="app-modal-actions folder-delete-actions">
              <button type="button" className="ui-btn" onClick={() => setDeleting(null)}>
                {tr("cancel")}
              </button>
              <button type="button" className="folder-delete-btn is-confirm" autoFocus onClick={() => void confirmDelete()}>
                {tr("deleteFolder")}
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );
}

function PitchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        d="M2.5 5.5h4l1.2-1.5H15.5v9.5h-13V5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
    </svg>
  );
}
