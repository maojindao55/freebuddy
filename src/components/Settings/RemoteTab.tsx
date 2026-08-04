import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  Check,
  Users,
  UserPlus,
  User,
  ShieldCheck,
  Key,
  Trash2,
  Folder,
  FolderPlus,
  X,
  ExternalLink,
  Eye,
  EyeOff,
  AlertCircle,
  AlertTriangle,
  Laptop,
  Plus,
  Info,
  Search,
  Monitor,
  LogOut,
  Pencil,
  Ban,
  CheckCircle2,
  RefreshCw,
  ChevronDown
} from "lucide-react";

import { copyToClipboard as writeClipboard } from "@/utils/clipboard";

const MIN_PASSWORD_LENGTH = 8;
const STATUS_POLL_MS = 15000;

type ToastKind = "success" | "error" | "info";

function formatTime(value: number | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** Turns a User-Agent string into something a human can recognise at a glance. */
function describeDevice(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const os =
    /iPhone|iPad/i.test(userAgent) ? "iOS"
      : /Android/i.test(userAgent) ? "Android"
      : /Mac OS X/i.test(userAgent) ? "macOS"
      : /Windows/i.test(userAgent) ? "Windows"
      : /Linux/i.test(userAgent) ? "Linux"
      : null;
  const browser =
    /Edg\//i.test(userAgent) ? "Edge"
      : /OPR\//i.test(userAgent) ? "Opera"
      : /Firefox\//i.test(userAgent) ? "Firefox"
      : /Chrome\//i.test(userAgent) ? "Chrome"
      : /Safari\//i.test(userAgent) ? "Safari"
      : null;
  if (os && browser) return `${browser} · ${os}`;
  return browser ?? os;
}

function isNestedUnder(candidate: string, root: string): boolean {
  const sep = root.includes("\\") ? "\\" : "/";
  const normalized = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return candidate === normalized || candidate.startsWith(normalized + sep);
}

export function RemoteTab() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [serverConfig, setServerConfig] = useState<RemoteServerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<RemoteUser[]>([]);
  const [userRootsMap, setUserRootsMap] = useState<Record<string, string[]>>({});
  const [missingRoots, setMissingRoots] = useState<Set<string>>(new Set());
  const [sessions, setSessions] = useState<RemoteSessionInfo[]>([]);
  const [auditEntries, setAuditEntries] = useState<RemoteAuditEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddUserForm, setShowAddUserForm] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newStrictIsolation, setNewStrictIsolation] = useState(false);
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null);
  const [showRevealedPassword, setShowRevealedPassword] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: ToastKind } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<
    { id: string; footprint: RemoteUserDataFootprint } | null
  >(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [passwordEdit, setPasswordEdit] = useState<{ id: string; value: string } | null>(null);
  const [portDraft, setPortDraft] = useState("");
  const [revokeAllArmed, setRevokeAllArmed] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  const toastTimerRef = useRef<number | null>(null);
  const isWeb = window.freebuddy?.platform === "web";

  const showToast = useCallback((message: string, type: ToastKind = "info") => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, type });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  const reportError = useCallback(
    (error: unknown) => {
      const raw = String((error as Error)?.message || error);
      const known: Record<string, string> = {
        username_taken: t("remote.usernameTaken"),
        invalid_username: t("remote.usernameInvalid"),
        password_too_short: t("remote.passwordTooShort")
      };
      showToast(known[raw] ?? raw, "error");
    },
    [showToast, t]
  );

  const copyToClipboard = (text: string, key: string) => {
    void writeClipboard(text)
      .then(() => {
        setCopiedKey(key);
        showToast(t("common.copied"), "success");
        setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 2000);
      })
      .catch(() => {
        showToast(t("common.copyFailed"), "error");
      });
  };

  const loadRootsForUsers = async (usersList: RemoteUser[]) => {
    try {
      const entries = await Promise.all(
        usersList.map(async (u) => {
          const roots = (await window.freebuddy?.remote?.listUserRoots(u.id)) ?? [];
          return [u.id, roots] as const;
        })
      );
      setUserRootsMap(Object.fromEntries(entries));
      const allRoots = [...new Set(entries.flatMap(([, roots]) => roots))];
      if (allRoots.length > 0) {
        const existence =
          (await window.freebuddy?.remote?.checkRootsExist(allRoots)) ?? {};
        setMissingRoots(new Set(allRoots.filter((root) => existence[root] === false)));
      } else {
        setMissingRoots(new Set());
      }
    } catch {
      setUserRootsMap({});
    }
  };

  const refresh = useCallback(async () => {
    try {
      const remote = window.freebuddy?.remote;
      const [s, cfg, us, ss] = await Promise.all([
        remote?.getStatus(),
        remote?.getServerConfig(),
        remote?.listUsers(),
        remote?.listSessions()
      ]);
      setStatus(s ?? null);
      if (cfg) {
        setServerConfig(cfg);
        setPortDraft((curr) => (curr === "" ? String(cfg.port) : curr));
      }
      const list = us ?? [];
      setUsers(list);
      setSessions(ss ?? []);
      await loadRootsForUsers(list);
    } catch (e) {
      reportError(e);
    } finally {
      setLoading(false);
    }
  }, [reportError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The listening port and the LAN address both change underneath us — after a
  // port conflict, or when the machine moves between networks.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const remote = window.freebuddy?.remote;
          const [s, ss] = await Promise.all([remote?.getStatus(), remote?.listSessions()]);
          if (s) setStatus(s);
          if (ss) setSessions(ss);
        } catch {
          /* transient; the next tick retries */
        }
      })();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const entries = (await window.freebuddy?.remote?.listAuditLog(200)) ?? [];
      setAuditEntries(entries);
    } catch (e) {
      reportError(e);
    }
  }, [reportError]);

  useEffect(() => {
    if (showAudit) void loadAudit();
  }, [showAudit, loadAudit]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = (enabled: boolean) =>
    runAction(async () => {
      const res = await window.freebuddy!.remote!.setEnabled(enabled);
      if (res?.status) setStatus(res.status);
      if (res?.initialPassword) {
        setRevealed({ username: "buddy", password: res.initialPassword });
        setShowRevealedPassword(true);
        showToast(t("remote.userCreated"), "success");
      } else {
        setRevealed(null);
      }
      await refresh();
    });

  const handleApplyServerConfig = (bindMode?: RemoteBindMode) =>
    runAction(async () => {
      const port = Number.parseInt(portDraft, 10);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        showToast(t("remote.serverPortInvalid"), "error");
        return;
      }
      const next = await window.freebuddy!.remote!.setServerConfig({
        port,
        bindMode: bindMode ?? serverConfig?.bindMode
      });
      setStatus(next);
      showToast(t("remote.serverApplied"), "success");
      await refresh();
    });

  const handleCreateUser = () =>
    runAction(async () => {
      const username = newUsername.trim();
      if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
        showToast(t("remote.usernameInvalid"), "error");
        return;
      }
      const password = newPassword.trim();
      if (password && password.length < MIN_PASSWORD_LENGTH) {
        showToast(t("remote.passwordTooShort"), "error");
        return;
      }
      const res = await window.freebuddy!.remote!.createUser({
        username,
        password: password || undefined,
        strictIsolation: newStrictIsolation
      });
      setNewUsername("");
      setNewPassword("");
      setNewStrictIsolation(false);
      setShowAddUserForm(false);
      setRevealed({ username: res.user.username, password: res.password });
      setShowRevealedPassword(true);
      showToast(t("remote.userCreated"), "success");
      await refresh();
    });

  const handleResetUserPassword = (id: string, username: string) =>
    runAction(async () => {
      const res = await window.freebuddy!.remote!.resetUserPassword(id);
      if (res) {
        setRevealed({ username, password: res.password });
        setShowRevealedPassword(true);
        showToast(t("remote.passwordReset"), "success");
      }
      await refresh();
    });

  const handleSetUserPassword = () =>
    runAction(async () => {
      if (!passwordEdit) return;
      const password = passwordEdit.value.trim();
      if (password.length < MIN_PASSWORD_LENGTH) {
        showToast(t("remote.passwordTooShort"), "error");
        return;
      }
      await window.freebuddy!.remote!.setUserPassword({ id: passwordEdit.id, password });
      setPasswordEdit(null);
      showToast(t("remote.passwordUpdated"), "success");
      await refresh();
    });

  const handleRename = () =>
    runAction(async () => {
      if (!renaming) return;
      await window.freebuddy!.remote!.renameUser({
        id: renaming.id,
        username: renaming.value.trim()
      });
      setRenaming(null);
      showToast(t("remote.userRenamed"), "success");
      await refresh();
    });

  const handleToggleDisabled = (user: RemoteUser) =>
    runAction(async () => {
      await window.freebuddy!.remote!.setUserDisabled({
        id: user.id,
        disabled: !user.disabled
      });
      showToast(user.disabled ? t("remote.userEnabled") : t("remote.userDisabled"), "success");
      await refresh();
    });

  const handleToggleStrictIsolation = (user: RemoteUser) =>
    runAction(async () => {
      await window.freebuddy!.remote!.setUserStrictIsolation({
        id: user.id,
        strictIsolation: !user.strictIsolation
      });
      showToast(
        user.strictIsolation
          ? t("remote.strictIsolationDisabled")
          : t("remote.strictIsolationEnabled"),
        "success"
      );
      await refresh();
    });

  const handleDeleteUser = (id: string) =>
    runAction(async () => {
      if (deleteConfirm?.id !== id) {
        // Show what the deletion takes with it before asking for confirmation.
        const footprint = await window.freebuddy!.remote!.getUserDataFootprint(id);
        setDeleteConfirm({ id, footprint });
        return;
      }
      setDeleteConfirm(null);
      await window.freebuddy!.remote!.deleteUser(id);
      showToast(t("remote.userDeleted"), "success");
      await refresh();
    });

  const handleRevokeSession = (tokenHash: string) =>
    runAction(async () => {
      await window.freebuddy!.remote!.revokeSession(tokenHash);
      showToast(t("remote.sessionRevoked"), "success");
      await refresh();
    });

  const handleRevokeUserSessions = (userId: string) =>
    runAction(async () => {
      await window.freebuddy!.remote!.revokeUserSessions(userId);
      showToast(t("remote.sessionRevoked"), "success");
      await refresh();
    });

  const handleRevokeAll = () =>
    runAction(async () => {
      if (!revokeAllArmed) {
        setRevokeAllArmed(true);
        window.setTimeout(() => setRevokeAllArmed(false), 4000);
        return;
      }
      setRevokeAllArmed(false);
      await window.freebuddy!.remote!.revokeAllSessions();
      showToast(t("remote.sessionRevokedAll"), "success");
      await refresh();
    });

  const persistRoots = async (userId: string, next: string[]) => {
    try {
      const saved = await window.freebuddy?.remote?.setUserRoots({ userId, roots: next });
      setUserRootsMap((prev) => ({ ...prev, [userId]: saved ?? next }));
      showToast(t("remote.rootsSaved"), "success");
    } catch (e) {
      reportError(e);
    }
  };

  const handleBrowseFolderForUser = async (userId: string) => {
    try {
      const path = await (window.freebuddy?.skills?.selectDirectory?.() ??
        window.freebuddy?.cli?.selectDirectory?.());
      if (!path) return;
      const current = userRootsMap[userId] ?? [];
      if (current.includes(path)) {
        showToast(t("remote.rootsDuplicate"), "info");
        return;
      }
      // A child of an assigned root grants nothing extra but looks like it does.
      if (current.some((root) => isNestedUnder(path, root))) {
        showToast(t("remote.rootsNested", { path }), "info");
        return;
      }
      // Dropping now-redundant children keeps the pill list honest.
      const pruned = current.filter((root) => !isNestedUnder(root, path));
      await persistRoots(userId, [...pruned, path]);
    } catch (e) {
      reportError(e);
    }
  };

  const handleRemoveRootForUser = async (userId: string, rootToRemove: string) => {
    const current = userRootsMap[userId] ?? [];
    await persistRoots(
      userId,
      current.filter((root) => root !== rootToRemove)
    );
  };

  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return users;
    const q = searchQuery.toLowerCase();
    return users.filter((u) => u.username.toLowerCase().includes(q));
  }, [users, searchQuery]);

  const sessionsByUser = useMemo(() => {
    const map = new Map<string, RemoteSessionInfo[]>();
    for (const session of sessions) {
      const list = map.get(session.userId) ?? [];
      list.push(session);
      map.set(session.userId, list);
    }
    return map;
  }, [sessions]);

  if (isWeb) {
    return (
      <section className="settings-section">
        <div className="remote-empty-state">
          <Laptop size={28} />
          <h3>{t("remote.title")}</h3>
          <p className="settings-hint">{t("remote.desktopOnly")}</p>
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="settings-section">
        <div className="remote-skeleton" />
      </section>
    );
  }

  const enabled = status?.enabled === true;
  const isRunning = status?.running === true;
  const portConflict =
    status && status.requestedPort !== status.port ? status : null;

  return (
    <div className="remote-tab">
      {toast && (
        <div className={`remote-toast remote-toast-${toast.type}`} role="status">
          <span>{toast.message}</span>
          <button type="button" className="remote-toast-close" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <section className="settings-section">
        <div className="remote-access-head">
          <div className="remote-access-copy">
            <div className="remote-title-row">
              <h3>{t("remote.title")}</h3>
              <span className={`remote-status ${isRunning ? "is-on" : "is-off"}`}>
                <span className="remote-status-dot" aria-hidden="true" />
                {isRunning
                  ? t("remote.statusOn", { port: status!.port, host: status!.host })
                  : t("remote.statusOff")}
              </span>
            </div>
            <p className="settings-hint">{t("remote.enableDescription")}</p>
          </div>
          <label className="fb-switch-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-checked={enabled}
              checked={enabled}
              disabled={busy}
              onChange={(e) => void handleToggle(e.target.checked)}
            />
            <span className="fb-switch fb-switch-lg" aria-hidden="true">
              <span className="fb-switch-thumb" />
            </span>
          </label>
        </div>

        {enabled && isRunning && (
          <div className="remote-access-body">
            <div className="remote-url-row">
              <code className="remote-url">{status!.accessUrl}</code>
              <button
                type="button"
                className={`permission-btn ${copiedKey === "accessUrl" ? "copied" : ""}`}
                onClick={() => copyToClipboard(status!.accessUrl, "accessUrl")}
              >
                {copiedKey === "accessUrl" ? <Check size={14} /> : <Copy size={14} />}
                <span>{copiedKey === "accessUrl" ? t("common.copied") : t("common.copy")}</span>
              </button>
              <button
                type="button"
                className="permission-btn"
                title={t("remote.openInBrowser")}
                onClick={() => window.open(status!.accessUrl, "_blank")}
              >
                <ExternalLink size={14} />
              </button>
            </div>

            {serverConfig && (
              <div className="remote-server-row">
                <label className="remote-field" htmlFor="remote-port">
                  <span>{t("remote.serverPort")}</span>
                  <span className="remote-port-controls">
                    <input
                      id="remote-port"
                      type="number"
                      className="remote-input remote-port-input"
                      min={1024}
                      max={65535}
                      value={portDraft}
                      disabled={busy}
                      onChange={(e) => setPortDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      className="permission-btn"
                      disabled={busy || portDraft === String(serverConfig.port)}
                      onClick={() => void handleApplyServerConfig()}
                    >
                      {t("remote.serverApply")}
                    </button>
                  </span>
                </label>

                <div className="remote-field">
                  <span>{t("remote.serverBindMode")}</span>
                  <div className="settings-choice-group remote-bind-group">
                    {(["lan", "local"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={serverConfig.bindMode === mode ? "active" : ""}
                        disabled={busy}
                        title={
                          mode === "lan"
                            ? t("remote.serverBindLanHint")
                            : t("remote.serverBindLocalHint")
                        }
                        onClick={() => {
                          if (serverConfig.bindMode === mode) return;
                          setServerConfig({ ...serverConfig, bindMode: mode });
                          void handleApplyServerConfig(mode);
                        }}
                      >
                        {mode === "lan"
                          ? t("remote.serverBindLan")
                          : t("remote.serverBindLocal")}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <p className="settings-hint">{t("remote.serverDescription")}</p>

            {status!.bindMode === "lan" && (
              <p className="settings-hint remote-inline-hint">
                {t("remote.lanIpHint", { ip: status!.lanIp, port: status!.port })}
              </p>
            )}
            {portConflict && (
              <p className="remote-inline-hint is-warn">
                <AlertTriangle size={13} />
                <span>
                  {t("remote.serverPortFallback", {
                    requested: portConflict.requestedPort,
                    actual: portConflict.port
                  })}
                </span>
              </p>
            )}
            {status!.exposedOverPlainHttp && (
              <p className="remote-inline-hint is-warn">
                <AlertTriangle size={13} />
                <span>
                  {t("remote.insecureWarning")}{" "}
                  <a
                    href="https://github.com/maojindao55/freebuddy/blob/main/docs/remote-access.md#public--https-deployment"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("remote.insecureWarningLink")}
                  </a>
                </span>
              </p>
            )}
          </div>
        )}
      </section>

      {enabled && (
        <section className="settings-section">
          <div className="remote-section-head">
            <div>
              <h3>{t("remote.unifiedTitle")}</h3>
              <p className="settings-hint">{t("remote.unifiedDescription")}</p>
            </div>
            <div className="remote-section-actions">
              {users.length > 3 && (
                <div className="remote-search">
                  <Search size={14} />
                  <input
                    type="text"
                    placeholder={t("remote.filterUsersPlaceholder")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button type="button" onClick={() => setSearchQuery("")}>
                      <X size={12} />
                    </button>
                  )}
                </div>
              )}
              {sessions.length > 0 && (
                <button
                  type="button"
                  className={`permission-btn ${revokeAllArmed ? "permission-btn-danger" : ""}`}
                  disabled={busy}
                  onClick={() => void handleRevokeAll()}
                >
                  {revokeAllArmed
                    ? t("remote.sessionRevokeAllConfirm")
                    : t("remote.sessionRevokeAll")}
                </button>
              )}
              <button
                type="button"
                className={`permission-btn ${showAddUserForm ? "" : "permission-btn-primary"}`}
                onClick={() => setShowAddUserForm(!showAddUserForm)}
              >
                <UserPlus size={15} />
                <span>{t("remote.createUser")}</span>
              </button>
            </div>
          </div>

          {showAddUserForm && (
            <div className="remote-form-panel">
              <div className="remote-form-row">
                <input
                  type="text"
                  className="remote-input"
                  placeholder={t("remote.usernamePlaceholder")}
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateUser();
                  }}
                />
                <input
                  type="text"
                  className="remote-input"
                  placeholder={t("remote.newPasswordPlaceholder")}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateUser();
                  }}
                />
                <button
                  type="button"
                  className="permission-btn permission-btn-primary"
                  disabled={busy || !newUsername.trim()}
                  onClick={() => void handleCreateUser()}
                >
                  <Plus size={16} />
                  <span>{t("remote.createUser")}</span>
                </button>
                <button
                  type="button"
                  className="permission-btn"
                  onClick={() => setShowAddUserForm(false)}
                >
                  {t("common.cancel")}
                </button>
              </div>
              <label className="remote-form-row remote-strict-isolation">
                <input
                  type="checkbox"
                  checked={newStrictIsolation}
                  disabled={busy}
                  onChange={(e) => setNewStrictIsolation(e.target.checked)}
                />
                <span>
                  <strong>{t("remote.strictIsolation")}</strong>
                  <span className="settings-hint">{t("remote.strictIsolationHint")}</span>
                </span>
              </label>
              <p className="settings-hint remote-form-hint">
                <AlertCircle size={12} />
                <span>
                  {t("remote.usernameHint")} · {t("remote.passwordMinLength")}
                </span>
              </p>
            </div>
          )}

          {revealed && (
            <div className="remote-credential">
              <div className="remote-credential-top">
                <strong>{t("remote.credentialReveal")}</strong>
                <span className="settings-hint">{t("remote.credentialOnceHint")}</span>
              </div>
              <div className="remote-credential-body">
                <div className="remote-credential-fields">
                  <span>
                    <span className="remote-muted">{t("remote.rootsForUser")}</span>{" "}
                    <strong>{revealed.username}</strong>
                  </span>
                  <span>
                    <span className="remote-muted">{t("remote.passwordTitle")}</span>{" "}
                    <code>
                      {showRevealedPassword ? revealed.password : "••••••••••••"}
                    </code>
                  </span>
                </div>
                <div className="remote-credential-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={
                      showRevealedPassword ? t("remote.hidePassword") : t("remote.showPassword")
                    }
                    onClick={() => setShowRevealedPassword(!showRevealedPassword)}
                  >
                    {showRevealedPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  <button
                    type="button"
                    className={`permission-btn ${copiedKey === "password" ? "copied" : ""}`}
                    onClick={() => copyToClipboard(revealed.password, "password")}
                  >
                    {copiedKey === "password" ? <Check size={14} /> : <Copy size={14} />}
                    <span>{copiedKey === "password" ? t("common.copied") : t("common.copy")}</span>
                  </button>
                  <button type="button" className="icon-btn" onClick={() => setRevealed(null)}>
                    <X size={15} />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="remote-user-list">
            {filteredUsers.length === 0 ? (
              <div className="remote-empty-inline">
                <Users size={20} />
                <span>{searchQuery ? t("remote.noUsersFound") : t("remote.noUsers")}</span>
              </div>
            ) : (
              filteredUsers.map((u) => {
                const userRoots = userRootsMap[u.id] ?? [];
                const userSessions = sessionsByUser.get(u.id) ?? [];
                const pendingDelete = deleteConfirm?.id === u.id;
                const expanded = expandedUserId === u.id;

                return (
                  <div
                    key={u.id}
                    className={`remote-user ${u.isOwner ? "is-owner" : ""} ${
                      u.disabled ? "is-disabled" : ""
                    } ${expanded ? "is-expanded" : ""}`}
                  >
                    <button
                      type="button"
                      className="remote-user-summary"
                      aria-expanded={expanded}
                      onClick={() => {
                        setExpandedUserId(expanded ? null : u.id);
                        setPasswordEdit(null);
                        setRenaming(null);
                        setDeleteConfirm(null);
                      }}
                    >
                      <span className="remote-user-avatar" aria-hidden="true">
                        {u.isOwner ? <ShieldCheck size={16} /> : <User size={16} />}
                      </span>
                      <span className="remote-user-meta">
                        <span className="remote-username">{u.username}</span>
                        <span className={`remote-badge ${u.isOwner ? "owner" : "member"}`}>
                          {u.isOwner ? t("remote.ownerBadge") : t("remote.memberBadge")}
                        </span>
                        {u.disabled && (
                          <span className="remote-badge disabled">{t("remote.disabledBadge")}</span>
                        )}
                        {!u.isOwner && u.strictIsolation && (
                          <span className="remote-badge member">
                            {t("remote.strictIsolationBadge")}
                          </span>
                        )}
                        {userSessions.length > 0 && (
                          <span className="remote-session-count">
                            <Monitor size={11} />
                            {t("remote.sessionCount", { count: userSessions.length })}
                          </span>
                        )}
                        {!u.isOwner && userRoots.length === 0 && (
                          <span className="remote-badge warn" title={t("remote.noRootsWarning")}>
                            {t("remote.noRootsAssigned")}
                          </span>
                        )}
                      </span>
                      <ChevronDown
                        size={16}
                        className={`remote-user-chevron ${expanded ? "is-open" : ""}`}
                      />
                    </button>

                    {expanded && (
                      <div className="remote-user-details">
                        {!u.isOwner ? (
                          <label className="remote-form-row remote-strict-isolation">
                            <input
                              type="checkbox"
                              checked={u.strictIsolation}
                              disabled={busy}
                              onChange={() => void handleToggleStrictIsolation(u)}
                            />
                            <span>
                              <strong>{t("remote.strictIsolation")}</strong>
                              <span className="settings-hint">
                                {t("remote.strictIsolationHint")}
                              </span>
                            </span>
                          </label>
                        ) : (
                          <p className="settings-hint remote-form-hint">
                            {t("remote.strictIsolationOwnerHint")}
                          </p>
                        )}
                        <div className="remote-user-actions">
                          <button
                            type="button"
                            className="permission-btn"
                            disabled={busy}
                            onClick={() => setRenaming({ id: u.id, value: u.username })}
                          >
                            <Pencil size={14} />
                            <span>{t("remote.rename")}</span>
                          </button>
                          <button
                            type="button"
                            className="permission-btn"
                            disabled={busy}
                            onClick={() =>
                              setPasswordEdit(
                                passwordEdit?.id === u.id ? null : { id: u.id, value: "" }
                              )
                            }
                          >
                            <Key size={14} />
                            <span>{t("remote.setPassword")}</span>
                          </button>
                          <button
                            type="button"
                            className="permission-btn"
                            disabled={busy}
                            onClick={() => void handleResetUserPassword(u.id, u.username)}
                          >
                            <RefreshCw size={14} />
                            <span>{t("remote.resetUserPassword")}</span>
                          </button>
                          {!u.isOwner && (
                            <button
                              type="button"
                              className="permission-btn"
                              disabled={busy}
                              onClick={() => void handleToggleDisabled(u)}
                            >
                              {u.disabled ? <CheckCircle2 size={14} /> : <Ban size={14} />}
                              <span>{u.disabled ? t("remote.enable") : t("remote.disable")}</span>
                            </button>
                          )}
                          {!u.isOwner && (
                            <button
                              type="button"
                              className={`permission-btn ${
                                pendingDelete ? "permission-btn-danger" : ""
                              }`}
                              disabled={busy}
                              onClick={() => void handleDeleteUser(u.id)}
                            >
                              <Trash2 size={14} />
                              <span>
                                {pendingDelete
                                  ? t("remote.confirmDeleteUser", { username: u.username })
                                  : t("remote.deleteUser")}
                              </span>
                            </button>
                          )}
                        </div>

                        {renaming?.id === u.id && (
                          <div className="remote-form-row">
                            <input
                              autoFocus
                              className="remote-input remote-rename-input"
                              value={renaming.value}
                              onChange={(e) =>
                                setRenaming({ id: u.id, value: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void handleRename();
                                if (e.key === "Escape") setRenaming(null);
                              }}
                            />
                            <button
                              type="button"
                              className="permission-btn permission-btn-primary"
                              disabled={busy}
                              onClick={() => void handleRename()}
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              className="permission-btn"
                              onClick={() => setRenaming(null)}
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        )}

                        {pendingDelete && (
                          <p className="remote-inline-hint is-danger">
                            <AlertTriangle size={13} />
                            <span>
                              {t("remote.deleteUserImpact", {
                                conversations: deleteConfirm.footprint.conversations,
                                tasks: deleteConfirm.footprint.scheduledTasks
                              })}
                            </span>
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => setDeleteConfirm(null)}
                            >
                              <X size={13} />
                            </button>
                          </p>
                        )}

                        {passwordEdit?.id === u.id && (
                          <div className="remote-form-row">
                            <input
                              autoFocus
                              type="text"
                              className="remote-input"
                              placeholder={t("remote.newPasswordPlaceholder")}
                              value={passwordEdit.value}
                              onChange={(e) =>
                                setPasswordEdit({ id: u.id, value: e.target.value })
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void handleSetUserPassword();
                                if (e.key === "Escape") setPasswordEdit(null);
                              }}
                            />
                            <button
                              type="button"
                              className="permission-btn permission-btn-primary"
                              disabled={busy}
                              onClick={() => void handleSetUserPassword()}
                            >
                              {t("remote.setPassword")}
                            </button>
                            <button
                              type="button"
                              className="permission-btn"
                              onClick={() => setPasswordEdit(null)}
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        )}

                        <div className="remote-detail-block">
                          <div className="remote-detail-label">
                            <Folder size={14} />
                            <span>{t("remote.rootsTitle")}</span>
                          </div>
                          <div className="remote-roots">
                            {userRoots.length === 0 ? (
                              u.isOwner ? (
                                <span
                                  className="remote-root is-default"
                                  title={t("remote.defaultRootsNotice")}
                                >
                                  <Info size={12} />
                                  {t("remote.defaultHomeAccess")}
                                </span>
                              ) : (
                                <span
                                  className="remote-root is-warn"
                                  title={t("remote.noRootsWarning")}
                                >
                                  <AlertTriangle size={12} />
                                  {t("remote.noRootsAssigned")}
                                </span>
                              )
                            ) : (
                              userRoots.map((root) => (
                                <span
                                  key={root}
                                  className={`remote-root ${
                                    missingRoots.has(root) ? "is-missing" : ""
                                  }`}
                                  title={
                                    missingRoots.has(root) ? t("remote.rootsMissing") : root
                                  }
                                >
                                  {missingRoots.has(root) ? (
                                    <AlertTriangle size={12} />
                                  ) : (
                                    <Folder size={12} />
                                  )}
                                  <code>{root}</code>
                                  <button
                                    type="button"
                                    title={t("remote.rootsRemove")}
                                    onClick={() => void handleRemoveRootForUser(u.id, root)}
                                  >
                                    <X size={12} />
                                  </button>
                                </span>
                              ))
                            )}
                            <button
                              type="button"
                              className="remote-root-add"
                              disabled={busy}
                              title={t("remote.browseFolder")}
                              onClick={() => void handleBrowseFolderForUser(u.id)}
                            >
                              <FolderPlus size={13} />
                              <span>{t("remote.addDirectory")}</span>
                            </button>
                          </div>
                        </div>

                        {userSessions.length > 0 && (
                          <div className="remote-detail-block">
                            <div className="remote-detail-label">
                              <Monitor size={14} />
                              <span>{t("remote.sessionsTitle")}</span>
                              <button
                                type="button"
                                className="remote-text-btn is-danger"
                                disabled={busy}
                                onClick={() => void handleRevokeUserSessions(u.id)}
                              >
                                {t("remote.sessionRevokeUser")}
                              </button>
                            </div>
                            <ul className="remote-sessions">
                              {userSessions.map((session) => (
                                <li key={session.tokenHash}>
                                  <span
                                    className={`remote-session-dot ${
                                      session.online ? "online" : "idle"
                                    }`}
                                    title={
                                      session.online
                                        ? t("remote.sessionOnline")
                                        : t("remote.sessionOffline")
                                    }
                                  />
                                  <div className="remote-session-info">
                                    <span>
                                      {describeDevice(session.userAgent) ??
                                        t("remote.sessionUnknownDevice")}
                                      {session.ip ? ` · ${session.ip}` : ""}
                                    </span>
                                    <small className="settings-hint">
                                      {t("remote.sessionSignedInAt", {
                                        time: formatTime(session.createdAt)
                                      })}
                                      {" · "}
                                      {t("remote.sessionLastSeen", {
                                        time: formatTime(
                                          session.lastSeenAt ?? session.createdAt
                                        )
                                      })}
                                    </small>
                                  </div>
                                  <button
                                    type="button"
                                    className="permission-btn"
                                    disabled={busy}
                                    onClick={() => void handleRevokeSession(session.tokenHash)}
                                  >
                                    <LogOut size={13} />
                                    <span>{t("remote.sessionRevoke")}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}

      {enabled && (
        <section className="settings-section">
          <details
            className="remote-audit"
            open={showAudit}
            onToggle={(e) => setShowAudit((e.target as HTMLDetailsElement).open)}
          >
            <summary>
              <span>
                <strong>{t("remote.auditTitle")}</strong>
                <span className="settings-hint">{t("remote.auditDescription")}</span>
              </span>
              <span className="remote-audit-toggle">
                {showAudit ? t("remote.auditHide") : t("remote.auditShow")}
              </span>
            </summary>
            <div className="remote-audit-toolbar">
              <button
                type="button"
                className="permission-btn"
                onClick={() => void loadAudit()}
              >
                <RefreshCw size={14} />
                <span>{t("remote.auditRefresh")}</span>
              </button>
            </div>
            <div className="remote-audit-list">
              {auditEntries.length === 0 ? (
                <div className="remote-empty-inline">
                  <span>{t("remote.auditEmpty")}</span>
                </div>
              ) : (
                auditEntries.map((entry) => (
                  <div key={entry.id} className="remote-audit-row">
                    <span className="remote-audit-time">{formatTime(entry.createdAt)}</span>
                    <span className={`remote-audit-event ${entry.event.replace(/\./g, "-")}`}>
                      {t(`remote.auditEvent.${entry.event}`, { defaultValue: entry.event })}
                    </span>
                    <span className="remote-audit-actor">
                      {entry.actorName ?? "—"}
                      {entry.targetName && entry.targetName !== entry.actorName
                        ? ` → ${entry.targetName}`
                        : ""}
                    </span>
                    <span className="remote-audit-detail">
                      {[entry.ip, entry.detail].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                ))
              )}
            </div>
          </details>
        </section>
      )}
    </div>
  );
}
