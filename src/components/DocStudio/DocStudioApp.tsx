import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Bot,
  CheckCircle2,
  FileSpreadsheet,
  FileText,
  FileCode,
  FolderDown,
  LoaderCircle,
  Plus,
  Save,
  FolderOpen,
  Folder,
  X,
  Check,
  AlertCircle
} from "lucide-react";
import type { DocTab, DocKind, SheetWorkbookData, SelectionContext } from "./types";
import {
  parseCsvToWorkbook,
  exportWorkbookToCsv,
  exportWorkbookToXlsx,
  a1ToRowCol,
  evaluateFormula
} from "./utils/sheetParser";
import { recalculateWorkbook } from "./utils/formulaEngine";
import { SpreadsheetEditor } from "./SpreadsheetEditor";
import { TextDocEditor } from "./TextDocEditor";
import { DocStudioCopilot } from "./DocStudioCopilot";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../store/settingsStore";
import "./docStudio.css";

function parseDocResult(
  res: { name?: string; ext?: string; content?: string; bufferBase64?: string },
  filePath: string
): {
  fileName: string;
  ext: string;
  kind: DocKind;
  content?: string;
  sheetData?: SheetWorkbookData;
} {
  const fileName = res.name || filePath.split("/").pop() || "Untitled";
  const ext = (res.ext || "").toLowerCase();
  if (ext === ".csv" || ext === ".tsv") {
    return { fileName, ext, kind: "sheet", sheetData: parseCsvToWorkbook(res.content || "", fileName) };
  }
  if (ext === ".md") return { fileName, ext, kind: "markdown", content: res.content || "" };
  if (ext === ".json") return { fileName, ext, kind: "json", content: res.content || "" };
  return { fileName, ext, kind: "text", content: res.content || "" };
}

// Engine-rendered office files (doc/slide/pdf families plus the binary Excel
// family) reuse the locally installed WorkBuddy Tencent Docs engine via an
// embedded preview (see electron/officeEngineCore.ts). The engine edits and
// saves the file itself; DocStudio only hosts the view. .csv/.tsv keep the
// lightweight built-in sheet editor.
const ENGINE_EXTS = new Set([
  ".doc", ".docx", ".dot", ".dotx", ".wps", ".wpt", ".docm", ".dotm",
  ".xls", ".xlsx", ".xlt", ".xltx", ".xlsm", ".xltm",
  ".pptx", ".ppt", ".pps", ".pot", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm",
  ".pdf"
]);

function splitFileName(filePath: string): { fileName: string; ext: string } {
  const fileName = filePath.split(/[\\/]/).pop() || "Untitled";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  return { fileName, ext };
}

function isEngineFileExt(ext: string): boolean {
  return ENGINE_EXTS.has(ext.toLowerCase());
}

interface DocStudioAppProps {
  initialFilePath?: string;
}

interface SheetHistory {
  past: SheetWorkbookData[];
  future: SheetWorkbookData[];
}

const COPILOT_WIDTH_KEY = "docStudio.copilotWidth";
const COPILOT_MIN = 320;
const COPILOT_MAX = 640;
const COPILOT_DEFAULT = 400;
const HISTORY_LIMIT = 100;

export const DocStudioApp: React.FC<DocStudioAppProps> = ({ initialFilePath }) => {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showCopilot, setShowCopilot] = useState(true);
  const [selectionContext, setSelectionContext] = useState<SelectionContext | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{
    kind: "info" | "error";
    text: string;
    action?: { label: string; run: () => void };
  } | null>(null);
  const [histories, setHistories] = useState<Record<string, SheetHistory>>({});
  const [copilotWidth, setCopilotWidth] = useState(() => {
    const raw = Number(localStorage.getItem(COPILOT_WIDTH_KEY));
    return raw >= COPILOT_MIN && raw <= COPILOT_MAX ? raw : COPILOT_DEFAULT;
  });
  const toastTimerRef = useRef<number | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const isMac = window.freebuddy?.platform === "darwin";

  // Theme sync (same as ButlerBuddyChat)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  useEffect(() => {
    void useSettingsStore.getState().load();
    const off = window.freebuddy?.window?.onAppearanceChanged?.((theme) => {
      if (theme === "system" || theme === "light" || theme === "dark") {
        void useSettingsStore.getState().setTheme(theme, { syncPeers: false });
      }
    });
    return () => off?.();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  const showToast = useCallback(
    (kind: "info" | "error", text: string, action?: { label: string; run: () => void }) => {
      setToast({ kind, text, action });
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
    },
    []
  );

  // Copilot panel resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const next = Math.min(
        COPILOT_MAX,
        Math.max(COPILOT_MIN, r.startWidth + (r.startX - e.clientX))
      );
      setCopilotWidth(next);
      localStorage.setItem(COPILOT_WIDTH_KEY, String(next));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.classList.remove("ds-resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Helper to load file path into tab
  const openFileIntoTab = useCallback(async (filePath: string) => {
    if (!window.freebuddy?.docStudio) return;

    const { fileName, ext } = splitFileName(filePath);
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const activateTab = (newTab: DocTab) => {
      setTabs((prev) => {
        // If file is already open, activate it
        const existing = prev.find((t) => t.filePath === filePath);
        if (existing) {
          setActiveTabId(existing.id);
          return prev;
        }
        return [...prev, newTab];
      });
      setActiveTabId(newTab.id);
    };

    try {
      if (isEngineFileExt(ext)) {
        const res = await window.freebuddy.docStudio.getEnginePreview(filePath);
        if (!res.success || !res.url) {
          showToast("error", t("docStudio.openFailed", { err: res.error || "engineUnavailable" }));
          return;
        }
        activateTab({
          id: tabId,
          filePath,
          fileName,
          ext,
          kind: "office",
          isDirty: false,
          previewUrl: res.url
        });
        return;
      }

      const res = await window.freebuddy.docStudio.readFile(filePath);
      if (!res.success) {
        showToast("error", t("docStudio.openFailed", { err: res.error || "Unknown error" }));
        return;
      }

      const { kind, sheetData, content } = parseDocResult(res, filePath);
      activateTab({
        id: tabId,
        filePath,
        fileName,
        ext,
        kind,
        isDirty: false,
        content,
        sheetData
      });
    } catch (err) {
      console.error("[DocStudioApp] Open file failed:", err);
      showToast("error", t("docStudio.openFailed", { err: err instanceof Error ? err.message : String(err) }));
    }
  }, [showToast, t]);

  // Load initial file on mount if provided
  useEffect(() => {
    if (initialFilePath) {
      void openFileIntoTab(initialFilePath);
    }
  }, [initialFilePath, openFileIntoTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  const activeHistory = activeTab ? histories[activeTab.id] : undefined;
  const canUndo = Boolean(activeHistory?.past.length);
  const canRedo = Boolean(activeHistory?.future.length);

  const pushHistory = useCallback((tabId: string, snapshot: SheetWorkbookData) => {
    setHistories((prev) => {
      const h = prev[tabId] ?? { past: [], future: [] };
      return {
        ...prev,
        [tabId]: { past: [...h.past, snapshot].slice(-HISTORY_LIMIT), future: [] }
      };
    });
  }, []);

  const handleSheetChange = useCallback(
    (tabId: string, previous: SheetWorkbookData | undefined, updated: SheetWorkbookData) => {
      if (previous && previous !== updated) pushHistory(tabId, previous);
      const recalculated = recalculateWorkbook(updated);
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, isDirty: true, sheetData: recalculated } : t))
      );
    },
    [pushHistory]
  );

  const handleUndo = useCallback(() => {
    if (!activeTab?.sheetData) return;
    const h = histories[activeTab.id];
    if (!h?.past.length) return;
    const previous = h.past[h.past.length - 1];
    const current = activeTab.sheetData;
    setHistories((prev) => ({
      ...prev,
      [activeTab.id]: { past: h.past.slice(0, -1), future: [current, ...h.future] }
    }));
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, isDirty: true, sheetData: recalculateWorkbook(previous) } : t))
    );
  }, [activeTab, histories]);

  const handleRedo = useCallback(() => {
    if (!activeTab?.sheetData) return;
    const h = histories[activeTab.id];
    if (!h?.future.length) return;
    const next = h.future[0];
    const current = activeTab.sheetData;
    setHistories((prev) => ({
      ...prev,
      [activeTab.id]: { past: [...h.past, current], future: h.future.slice(1) }
    }));
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, isDirty: true, sheetData: recalculateWorkbook(next) } : t))
    );
  }, [activeTab, histories]);

  // Save current active tab
  const handleSaveActiveTab = useCallback(async () => {
    if (!activeTab || !window.freebuddy?.docStudio || saving) return;
    // Engine tabs persist through the engine's own editor chrome.
    if (activeTab.kind === "office") return;

    try {
      let payload: { content?: string; bufferBase64?: string } = {};

      if (activeTab.kind === "sheet" && activeTab.sheetData) {
        if (activeTab.ext === ".csv" || activeTab.ext === ".tsv") {
          const sheet = activeTab.sheetData.sheets[activeTab.sheetData.activeSheetIndex || 0];
          payload.content = exportWorkbookToCsv(sheet);
        } else {
          payload.bufferBase64 = exportWorkbookToXlsx(activeTab.sheetData);
        }
      } else {
        payload.content = activeTab.content || "";
      }

      setSaving(true);
      const res = await window.freebuddy.docStudio.writeFile(activeTab.filePath, payload);
      setSaving(false);
      if (res.success) {
        setTabs((prev) =>
          prev.map((t) => (t.id === activeTab.id ? { ...t, isDirty: false } : t))
        );
        showToast("info", t("docStudio.saved"));
      } else {
        showToast("error", t("docStudio.saveFailed", { err: res.error }));
      }
    } catch (err) {
      setSaving(false);
      console.error("[DocStudioApp] Save failed:", err);
      showToast("error", t("docStudio.saveFailed", { err: err instanceof Error ? err.message : String(err) }));
    }
  }, [activeTab, saving, showToast, t]);

  // Save As
  const handleSaveAs = async () => {
    if (!activeTab || !window.freebuddy?.docStudio) return;
    // Engine tabs persist through the engine's own editor chrome.
    if (activeTab.kind === "office") return;

    const filterExt = activeTab.ext.replace(/^\./, "");
    const targetPath = await window.freebuddy.docStudio.showSaveDialog(activeTab.fileName, [
      { name: "Current Format", extensions: [filterExt] },
      { name: "All Files", extensions: ["*"] }
    ]);

    if (!targetPath) return;

    try {
      let payload: { content?: string; bufferBase64?: string } = {};
      if (activeTab.kind === "sheet" && activeTab.sheetData) {
        if (targetPath.endsWith(".csv") || targetPath.endsWith(".tsv")) {
          const sheet = activeTab.sheetData.sheets[activeTab.sheetData.activeSheetIndex || 0];
          payload.content = exportWorkbookToCsv(sheet);
        } else {
          payload.bufferBase64 = exportWorkbookToXlsx(activeTab.sheetData);
        }
      } else {
        payload.content = activeTab.content || "";
      }

      const res = await window.freebuddy.docStudio.writeFile(targetPath, payload);
      if (res.success) {
        void openFileIntoTab(targetPath);
      }
    } catch (err) {
      console.error("[DocStudioApp] Save As failed:", err);
      showToast("error", t("docStudio.saveFailed", { err: err instanceof Error ? err.message : String(err) }));
    }
  };

  // Keyboard shortcuts: Cmd+S save, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z / Ctrl+Y redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField = !!target?.closest("input, textarea, [contenteditable]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSaveActiveTab();
        return;
      }
      if (inField || activeTab?.kind !== "sheet") return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z" && e.shiftKey) {
        e.preventDefault();
        handleRedo();
      } else if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        handleUndo();
      } else if (!isMac && e.ctrlKey && key === "y") {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSaveActiveTab, handleUndo, handleRedo, activeTab?.kind, isMac]);

  // Open file dialog
  const handleOpenFileDialog = async () => {
    if (!window.freebuddy?.docStudio) return;
    const paths = await window.freebuddy.docStudio.showOpenDialog();
    if (paths && paths.length > 0) {
      for (const p of paths) {
        await openFileIntoTab(p);
      }
    }
  };

  // Close tab
  const handleCloseTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const nextTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (nextTabs.length > 0) {
          const nextActive = nextTabs[Math.max(0, idx - 1)];
          setActiveTabId(nextActive.id);
        } else {
          setActiveTabId(null);
        }
      }
      return nextTabs;
    });
  };

  // Apply cell updates proposed by Copilot
  const applyCellUpdates = useCallback(
    (
      updates: Array<{ cell: string; value: string | number | null; formula?: string }>,
      skipToast = false
    ) => {
      if (!activeTab || activeTab.kind !== "sheet" || !activeTab.sheetData) return;

      const sheetIndex = activeTab.sheetData.activeSheetIndex || 0;
      const currentSheet = activeTab.sheetData.sheets[sheetIndex];
      if (!currentSheet) return;

      const newCells = { ...currentSheet.cells };
      let maxRow = currentSheet.rowCount;
      let maxCol = currentSheet.colCount;

      updates.forEach((u) => {
        const parsed = a1ToRowCol(u.cell);
        if (!parsed) return;
        maxRow = Math.max(maxRow, parsed.row + 5);
        maxCol = Math.max(maxCol, parsed.col + 5);
        const key = `${parsed.row}:${parsed.col}`;
        newCells[key] = {
          value: u.value,
          formula: u.formula,
          displayValue: u.value !== null && u.value !== undefined ? String(u.value) : ""
        };
      });

      // Evaluate formulas after all raw values are in place.
      updates.forEach((u) => {
        if (!u.formula) return;
        const parsed = a1ToRowCol(u.cell);
        if (!parsed) return;
        const key = `${parsed.row}:${parsed.col}`;
        const result = evaluateFormula(u.formula, newCells);
        newCells[key] = { ...newCells[key], value: result, displayValue: String(result) };
      });

      const updatedSheets = [...activeTab.sheetData.sheets];
      updatedSheets[sheetIndex] = {
        ...currentSheet,
        cells: newCells,
        rowCount: Math.max(currentSheet.rowCount, maxRow),
        colCount: Math.max(currentSheet.colCount, maxCol)
      };

      const updatedWb: SheetWorkbookData = {
        ...activeTab.sheetData,
        sheets: updatedSheets
      };

      handleSheetChange(activeTab.id, activeTab.sheetData, updatedWb);
      if (!skipToast) {
        showToast("info", t("docStudio.updatesApplied", { count: updates.length }));
      }
    },
    [activeTab, handleSheetChange, showToast, t]
  );

  // Auto-applied update tracking: record the history depth right after the
  // auto-apply so the copilot can offer undo only while it is the latest entry.
  const [autoApplyMark, setAutoApplyMark] = useState<{ tabId: string; depth: number } | null>(null);
  const autoApplyUndoable = Boolean(
    autoApplyMark &&
      histories[autoApplyMark.tabId]?.past.length === autoApplyMark.depth
  );

  const handleAutoApply = useCallback(
    (updates: Array<{ cell: string; value: string | number | null; formula?: string }>) => {
      if (!activeTab) return;
      const depth = (histories[activeTab.id]?.past.length ?? 0) + 1;
      applyCellUpdates(updates, true);
      setAutoApplyMark({ tabId: activeTab.id, depth });
      showToast("info", t("docStudio.autoApplied", { count: updates.length }));
    },
    [activeTab, histories, applyCellUpdates, showToast, t]
  );

  const handleUndoAutoApply = useCallback(() => {
    if (!autoApplyUndoable) return;
    handleUndo();
    setAutoApplyMark(null);
  }, [autoApplyUndoable, handleUndo]);

  // Watch open files for external changes and reload them live.
  const tabsRef = useRef<DocTab[]>([]);
  tabsRef.current = tabs;

  const reloadTabFromDisk = useCallback(
    async (filePath: string) => {
      const tab = tabsRef.current.find((tb) => tb.filePath === filePath);
      if (!tab || !window.freebuddy?.docStudio) return;
      try {
        const res = await window.freebuddy.docStudio.readFile(filePath);
        if (!res.success) return;
        const parsed = parseDocResult(res, filePath);
        setTabs((prev) =>
          prev.map((tb) => {
            if (tb.filePath !== filePath) return tb;
            if (parsed.sheetData && tb.sheetData) {
              pushHistory(tb.id, tb.sheetData);
              return {
                ...tb,
                isDirty: false,
                sheetData: {
                  ...parsed.sheetData,
                  activeSheetIndex: tb.sheetData.activeSheetIndex
                }
              };
            }
            return {
              ...tb,
              isDirty: false,
              kind: parsed.kind,
              content: parsed.content,
              sheetData: parsed.sheetData
            };
          })
        );
        showToast("info", t("docStudio.fileChangedReload"));
      } catch {
        /* keep current content */
      }
    },
    [pushHistory, showToast, t]
  );

  const handleFileChanged = useCallback(
    (filePath: string) => {
      const tab = tabsRef.current.find((tb) => tb.filePath === filePath);
      if (!tab) return;
      // Office-engine tabs host the engine's own editor; an on-disk change
      // (typically an agent save through the engine MCP) reloads the preview.
      if (tab.kind === "office") {
        setOfficeReloads((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
        return;
      }
      if (tab.isDirty) {
        showToast("info", t("docStudio.fileChangedDirty"), {
          label: t("docStudio.reload"),
          run: () => void reloadTabFromDisk(filePath)
        });
        return;
      }
      void reloadTabFromDisk(filePath);
    },
    [reloadTabFromDisk, showToast, t]
  );

  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.onFileChanged) return;
    return ds.onFileChanged(handleFileChanged);
  }, [handleFileChanged]);

  // Office-engine tab reload counters: bumping a counter remounts the embedded
  // engine preview (iframe key), which re-imports the freshly saved document.
  const [officeReloads, setOfficeReloads] = useState<Record<string, number>>({});

  const watchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.watchFile || !ds?.unwatchFile) return;
    // Watch every open file, including office-engine tabs: an agent that saves
    // the file through the engine MCP changes it on disk, and the watcher
    // reloads the embedded preview from the saved content.
    const paths = new Set(tabs.map((tb) => tb.filePath));
    paths.forEach((p) => {
      if (!watchedRef.current.has(p)) void ds.watchFile(p);
    });
    watchedRef.current.forEach((p) => {
      if (!paths.has(p)) void ds.unwatchFile(p);
    });
    watchedRef.current = paths;
  }, [tabs]);

  const statusText = saving
    ? t("docStudio.saving")
    : activeTab?.isDirty
      ? t("docStudio.unsavedChanges")
      : t("docStudio.saved");

  return (
    <div className="ds-root">
      {/* Row 1: Window title bar + document tabs (drag region) */}
      <div className={`ds-titlebar ${isMac ? "ds-titlebar-mac" : ""}`}>
        <div className="ds-tabs">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`ds-tab ${isActive ? "ds-tab-active" : ""}`}
                title={tab.filePath}
              >
                {tab.kind === "sheet" ? (
                  <FileSpreadsheet className="ds-tab-icon ds-tab-icon-sheet" />
                ) : tab.kind === "markdown" ? (
                  <FileCode className="ds-tab-icon ds-tab-icon-md" />
                ) : (
                  <FileText className="ds-tab-icon" />
                )}

                <span className="ds-tab-name">{tab.fileName}</span>

                {tab.isDirty && <span className="ds-dirty-dot" title={t("docStudio.unsavedChanges")} />}

                <button
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  className="ds-tab-close"
                  aria-label={t("docStudio.closeTab")}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}

          <button
            onClick={handleOpenFileDialog}
            className="ds-icon-btn"
            title={t("docStudio.openDocument")}
          >
            <Plus size={15} />
          </button>
        </div>

        <div className="ds-titlebar-actions" />
      </div>

      {/* Row 2: Document header (file info + actions) */}
      {activeTab && (
        <div className="ds-docheader">
          <div className="ds-docheader-info">
            {activeTab.kind === "sheet" ? (
              <FileSpreadsheet className="ds-doc-icon ds-tab-icon-sheet" />
            ) : activeTab.kind === "markdown" ? (
              <FileCode className="ds-doc-icon ds-tab-icon-md" />
            ) : (
              <FileText className="ds-doc-icon" />
            )}
            <span className="ds-doc-name" title={activeTab.fileName}>
              {activeTab.fileName}
            </span>
            <span className="ds-doc-status">
              {saving ? (
                <LoaderCircle size={12} className="ds-status-spin" />
              ) : activeTab.isDirty ? (
                <span className="ds-status-dot ds-status-dirty" />
              ) : (
                <CheckCircle2 size={12} className="ds-status-saved-icon" />
              )}
              {statusText}
            </span>
          </div>

          <div className="ds-docheader-actions">
            <button
              onClick={handleSaveActiveTab}
              className={`ds-icon-btn ${activeTab.isDirty ? "ds-icon-btn-brand" : ""}`}
              title={t("docStudio.saveShortcut")}
              disabled={saving || activeTab.kind === "office"}
            >
              <Save size={15} />
            </button>
            <button
              onClick={handleSaveAs}
              className="ds-icon-btn"
              title={t("docStudio.saveAs")}
              disabled={activeTab.kind === "office"}
            >
              <FolderDown size={15} />
            </button>
            <button
              onClick={() => {
                if (activeTab && window.freebuddy?.docStudio) {
                  void window.freebuddy.docStudio.showItemInFolder(activeTab.filePath);
                }
              }}
              className="ds-icon-btn"
              title={t("docStudio.showInFinder")}
            >
              <Folder size={15} />
            </button>
            {!showCopilot && (
              <button
                type="button"
                className="ds-ai-chat-btn"
                onClick={() => setShowCopilot(true)}
              >
                <Bot size={14} />
                <span>{t("docStudio.aiChat")}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Row 3: Workspace = editor + copilot */}
      <div className="ds-workspace">
        <div className="ds-editor">
          {activeTab ? (
            activeTab.kind === "office" && activeTab.previewUrl ? (
              <iframe
                key={`${activeTab.filePath}-${officeReloads[activeTab.filePath] ?? 0}`}
                src={activeTab.previewUrl}
                className="ds-office-frame"
                title={activeTab.fileName}
                allow="clipboard-read; clipboard-write"
              />
            ) : activeTab.kind === "sheet" && activeTab.sheetData ? (
              <SpreadsheetEditor
                workbook={activeTab.sheetData}
                onChange={(updated) => handleSheetChange(activeTab.id, activeTab.sheetData, updated)}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={canUndo}
                canRedo={canRedo}
                onAskAi={(ctx) => {
                  setSelectionContext(ctx);
                  setShowCopilot(true);
                }}
              />
            ) : (
              <TextDocEditor
                content={activeTab.content || ""}
                isMarkdown={activeTab.kind === "markdown"}
                onChange={(updated) => {
                  setTabs((prev) =>
                    prev.map((t) => (t.id === activeTab.id ? { ...t, isDirty: true, content: updated } : t))
                  );
                }}
                onAskAi={(text) => {
                  setSelectionContext({
                    rangeLabel: t("docStudio.selectedText"),
                    startRow: 0,
                    startCol: 0,
                    endRow: 0,
                    endCol: 0,
                    dataPreview: [[text]]
                  });
                  setShowCopilot(true);
                }}
              />
            )
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-icon">
                <FolderOpen size={28} />
              </div>
              <h3>{t("docStudio.noDocument")}</h3>
              <p>{t("docStudio.noDocumentHint")}</p>
              <button
                onClick={handleOpenFileDialog}
                className="ds-btn ds-btn-primary"
              >
                <Plus size={14} />
                <span>{t("docStudio.selectLocalFile")}</span>
              </button>
            </div>
          )}
        </div>

        {showCopilot && (
          <div className="ds-copilot-panel" style={{ width: copilotWidth }}>
            <div
              className="ds-resize-handle"
              onMouseDown={(e) => {
                e.preventDefault();
                resizeRef.current = { startX: e.clientX, startWidth: copilotWidth };
                document.body.classList.add("ds-resizing");
              }}
            />
            <DocStudioCopilot
              activeTab={activeTab}
              selectionContext={selectionContext}
              onClearSelectionContext={() => setSelectionContext(null)}
              onApplyCellUpdates={applyCellUpdates}
              onAutoApply={handleAutoApply}
              onUndoAutoApply={handleUndoAutoApply}
              autoApplyUndoable={autoApplyUndoable}
              onCollapse={() => setShowCopilot(false)}
            />
          </div>
        )}
      </div>

      {toast && (
        <div className={`ds-toast ${toast.kind === "error" ? "ds-toast-error" : ""}`} role="status">
          {toast.kind === "error" ? <AlertCircle size={13} /> : <Check size={13} />}
          <span>{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              className="ds-toast-action"
              onClick={() => {
                toast.action?.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
};
