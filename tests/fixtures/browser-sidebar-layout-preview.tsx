// Production sidebar, composer, browser, detail store and layout policy; no real agents.
import "./skill-commands-preview";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { PanelLeft, PanelRight } from "lucide-react";
import { ChatView } from "../../src/components/CLI/ChatView";
import { ConversationList } from "../../src/components/CLI/ConversationList";
import { DetailColumn } from "../../src/components/CLI/DetailColumn";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import { useBrowserSidebarLayout, resolveDetailWidth, getResponsiveDetailCollapse } from "../../src/hooks/useBrowserSidebarLayout";
import { useBrowserStore } from "../../src/store/browserStore";
import { useConversationStore } from "../../src/store/conversationStore";
import { useDetailLayoutStore, selectDetailWidth } from "../../src/store/detailLayoutStore";

const sampleUrl = new URL("/tests/fixtures/file-diff-browser.html", location.href).href;
const bridge = window.freebuddy!.cli!;
window.freebuddy!.cli = new Proxy(bridge, { get: (target, prop) => prop === "showNativeBrowser" ? undefined : target[prop] });
useDetailLayoutStore.setState({ loaded: true, activeTab: "overview", detailCollapsed: true, previewWidth: 680 });
useBrowserStore.setState({ ensureFor: async () => {} });

function LayoutPreview() {
  const [simulatedWidth, setSimulatedWidth] = useState<number>();
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  const [theme, setTheme] = useState("light");
  const activeId = useConversationStore(state => state.activeId);
  const activeTab = useDetailLayoutStore(state => state.activeTab);
  const detailCollapsed = useDetailLayoutStore(state => state.detailCollapsed);
  const detailWidth = useDetailLayoutStore(selectDetailWidth);
  const viewportWidth = Math.min(windowWidth, simulatedWidth ?? windowWidth);
  const previewOpen = activeTab === "preview" && !detailCollapsed;
  const { sidebarCollapsed, toggleSidebar } = useBrowserSidebarLayout({ viewportWidth, previewWidth: detailWidth, previewOpen, previewVisible: previewOpen, conversationId: activeId });
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const previousNarrow = useRef<boolean | null>(null);
  const previousTab = useRef(activeTab);
  useEffect(() => {
    const collapsed = getResponsiveDetailCollapse(viewportWidth, previousNarrow.current, activeTab === "preview", previousTab.current !== activeTab);
    if (collapsed !== undefined) useDetailLayoutStore.getState().setDetailCollapsed(collapsed);
    previousNarrow.current = viewportWidth < 1080;
    previousTab.current = activeTab;
  }, [viewportWidth, activeTab]);
  const visibleWidth = resolveDetailWidth(viewportWidth, detailWidth, sidebarCollapsed, !detailCollapsed);
  const openBrowser = () => {
    if (!activeId) return;
    useBrowserStore.setState(state => ({ byConv: { ...state.byConv, [activeId]: {
      cwd: "", manualEntry: sampleUrl, url: sampleUrl, history: [sampleUrl], historyIndex: 0,
      ready: true, reloadNonce: 0, loadState: "idle", updatedAt: new Date().toISOString()
    } } }));
    useDetailLayoutStore.setState({ activeTab: "preview", detailCollapsed: false });
  };
  return <div style={{ height: "100vh", background: "var(--fb-home-bg-secondary)", display: "flex", flexDirection: "column" }}>
    <style>{`.layout-fixture-shell { position: relative; inset: auto; transform: translateZ(0); flex: 1; min-height: 0; }
      .layout-fixture-shell .chat-composer { left: var(--fb-sidebar-width); right: var(--fb-detail-width); width: min(820px, calc(100% - var(--fb-sidebar-width) - var(--fb-detail-width) - 44px)); }
      .layout-fixture-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; min-height: 48px; padding: 8px 16px; border-bottom: 1px solid var(--fb-border); font-size: 12px; }
      .layout-fixture-controls button { display: inline-flex; gap: 6px; align-items: center; }
      .layout-fixture-titlebar { min-height: 44px; padding: 12px 20px; color: var(--fb-text-secondary); border-bottom: 1px solid var(--fb-border); }`}</style>
    <nav className="layout-fixture-controls" aria-label="布局预览控制">
      <button onClick={toggleSidebar} aria-label={sidebarCollapsed ? "展开会话列表" : "收起会话列表"} aria-expanded={!sidebarCollapsed}><PanelLeft size={15} />{sidebarCollapsed ? "展开会话列表" : "收起会话列表"}</button>
      <button onClick={openBrowser}><PanelRight size={15} />打开浏览器</button>
      <button onClick={() => useDetailLayoutStore.getState().setDetailCollapsed(true)}>关闭浏览器</button>
      <button onClick={() => setSimulatedWidth(1000)}>窄窗口 1000</button>
      <button onClick={() => setSimulatedWidth(undefined)}>恢复窗口宽度</button>
      <button onClick={() => { const next = theme === "light" ? "dark" : "light"; setTheme(next); document.documentElement.dataset.theme = next; }}>切换主题</button>
      <span role="status">布局宽度 {viewportWidth} · 左栏{sidebarCollapsed ? "收起" : "展开"}</span>
    </nav>
    <main className={`app-shell layout-fixture-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${detailCollapsed ? " detail-collapsed" : ""}${previewOpen ? " browser-preview-visible" : ""}`}
      style={{ width: viewportWidth, "--fb-detail-width": `${visibleWidth}px`, "--fb-sidebar-width": sidebarCollapsed ? "0px" : "272px" } as CSSProperties}>
      <aside className="sidebar"><ConversationList /></aside>
      <section className="workspace"><header className="layout-fixture-titlebar">优化登录页面的交互</header><div className="chat-section"><ChatView /></div></section>
      {!detailCollapsed && <DetailColumn runningCount={0} />}
    </main>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<ErrorBoundary><LayoutPreview /></ErrorBoundary>);
import.meta.hot?.dispose(() => root.unmount());
