import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const compile = file => ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 }
}).outputText;
let harnessId = 0;

async function harness(initial = {}) {
  const mockUrl = dataUrl(`
    // ${harnessId++}: isolate each hook instance, including effects and preferences.
    let slots = [], cursor = 0, pending = [], changed = false;
    const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    export const beginRender = () => { cursor = 0; pending = []; changed = false; };
    export const commit = () => { for (const effect of pending) effect(); return changed; };
    export function useState(initial) {
      const index = cursor++;
      if (!(index in slots)) {
        const cell = { value: typeof initial === "function" ? initial() : initial };
        cell.set = next => {
          const value = typeof next === "function" ? next(cell.value) : next;
          if (!Object.is(value, cell.value)) { cell.value = value; changed = true; }
        };
        slots[index] = cell;
      }
      return [slots[index].value, slots[index].set];
    }
    export function useLayoutEffect(effect, deps) {
      const index = cursor++;
      const old = slots[index];
      if (!old || !equal(old.deps, deps)) {
        const cell = { deps, cleanup: old?.cleanup };
        slots[index] = cell;
        pending.push(() => { cell.cleanup?.(); cell.cleanup = effect(); });
      }
    }
    export const useEffect = useLayoutEffect;
    export const useRef = initial => useState(() => ({ current: initial }))[0];
    export function useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index].value;
    }
    export const useCallback = (callback, deps) => useMemo(() => callback, deps);
    export const DETAIL_MIN_WIDTH = 320;
  `);
  const source = compile("../src/hooks/useBrowserSidebarLayout.ts").replace(/from\s+["']([^"']+)["']/g,
    (_, path) => `from ${JSON.stringify(path === "react" || path === "@/store/detailLayoutStore" ? mockUrl : path)}`);
  const hook = await import(dataUrl(source));
  const mock = await import(mockUrl);
  let options = {
    viewportWidth: 1280,
    previewWidth: 680,
    previewOpen: false,
    previewVisible: false,
    conversationId: "first",
    ...initial
  };
  const render = () => {
    for (let count = 0; count < 20; count++) {
      mock.beginRender();
      const result = hook.useBrowserSidebarLayout(options);
      if (!mock.commit()) return result;
    }
    assert.fail("layout did not settle after 20 renders");
  };
  return {
    render,
    change(patch) { options = { ...options, ...patch }; return render(); },
    toggle() { render().toggleSidebar(); return render(); },
    resolveDetailWidth: hook.resolveDetailWidth,
    getResponsiveDetailCollapse: hook.getResponsiveDetailCollapse
  };
}

test("opening a browser at 1280 keeps the sidebar and only insufficient width temporarily collapses it", async () => {
  const h = await harness();
  assert.equal(h.render().sidebarCollapsed, false);
  assert.equal(h.change({ previewOpen: true, previewVisible: true }).sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 1260 }).sidebarCollapsed, false, "the complete width budget fits exactly");
  assert.equal(h.change({ viewportWidth: 1259 }).sidebarCollapsed, true);
  assert.equal(h.change({ viewportWidth: 1200 }).sidebarCollapsed, true);
  assert.equal(h.change({ viewportWidth: 1440 }).sidebarCollapsed, false, "automatic collapse does not overwrite the expanded preference");
});

test("closing or folding the browser restores the sidebar that was temporarily hidden", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.render().sidebarCollapsed, true);
  assert.equal(h.change({ previewOpen: false, previewVisible: false }).sidebarCollapsed, false);
  assert.equal(h.change({ previewOpen: true, previewVisible: true }).sidebarCollapsed, true);
  assert.equal(h.change({ previewOpen: false, previewVisible: false }).sidebarCollapsed, false);
});

test("manually restoring an automatically collapsed sidebar is honored through subsequent resizes and close", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.render().sidebarCollapsed, true);
  assert.equal(h.toggle().sidebarCollapsed, false, "toggle uses the visible collapsed state, not the stored expanded preference");
  assert.equal(h.change({ viewportWidth: 1000 }).sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 1440 }).sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 1100 }).sidebarCollapsed, false);
  assert.equal(h.change({ previewOpen: false, previewVisible: false }).sidebarCollapsed, false);
});

test("a manual collapse remains the user preference after closing and reopening a wide browser", async () => {
  const h = await harness({ viewportWidth: 1440 });
  assert.equal(h.toggle().sidebarCollapsed, true);
  assert.equal(h.change({ previewOpen: true, previewVisible: true }).sidebarCollapsed, true);
  assert.equal(h.change({ previewOpen: false, previewVisible: false }).sidebarCollapsed, true);
  assert.equal(h.change({ previewOpen: true, previewVisible: true }).sidebarCollapsed, true);
  assert.equal(h.toggle().sidebarCollapsed, false);
  assert.equal(h.change({ previewOpen: false, previewVisible: false }).sidebarCollapsed, false);
});

test("reopening a browser starts a new automatic width budget after the previous manual override ends", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.toggle().sidebarCollapsed, false);
  assert.equal(h.change({ previewOpen: false, previewVisible: false }).sidebarCollapsed, false);
  assert.equal(h.change({ previewOpen: true, previewVisible: true }).sidebarCollapsed, true);
});

test("settings and other pages do not inherit a hidden browser's automatic sidebar collapse", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.render().sidebarCollapsed, true);
  assert.equal(h.change({ previewVisible: false }).sidebarCollapsed, false);
  assert.equal(h.change({ previewVisible: true }).sidebarCollapsed, true);
  assert.equal(h.toggle().sidebarCollapsed, false);
  assert.equal(h.change({ previewVisible: false }).sidebarCollapsed, false);
  assert.equal(h.change({ previewVisible: true }).sidebarCollapsed, false, "temporarily hiding the browser preserves this session's manual override");
});

test("a sidebar choice on another page updates the still-open browser's override", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.toggle().sidebarCollapsed, false);
  h.change({ previewVisible: false });
  assert.equal(h.toggle().sidebarCollapsed, true);
  assert.equal(h.toggle().sidebarCollapsed, false);
  assert.equal(h.change({ previewVisible: true }).sidebarCollapsed, false, "returning to the browser must respect the latest global sidebar choice");
});

test("changing conversations clears only the current browser override, while preserving manual preference", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.toggle().sidebarCollapsed, false);
  assert.equal(h.change({ conversationId: "second" }).sidebarCollapsed, true, "the previous conversation's expand override cannot leak into the next browser");
  assert.equal(h.change({ conversationId: undefined, previewOpen: false, previewVisible: false }).sidebarCollapsed, false, "new tasks keep the user's expanded preference");
  assert.equal(h.change({ conversationId: "second", previewOpen: true, previewVisible: true }).sidebarCollapsed, true);
});

test("a smaller requested browser width can make the three columns fit without hiding conversations", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: true, previewVisible: true });
  assert.equal(h.render().sidebarCollapsed, true);
  assert.equal(h.change({ previewWidth: 420 }).sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 1120 }).sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 1119 }).sidebarCollapsed, true);
  assert.equal(h.change({ previewWidth: 200, viewportWidth: 1020 }).sidebarCollapsed, false, "browser budget is bounded below by 320");
  assert.equal(h.change({ viewportWidth: 1019 }).sidebarCollapsed, true);
});

test("a previously selected but folded browser does not collapse navigation on resize", async () => {
  const h = await harness({ viewportWidth: 1200, previewOpen: false, previewVisible: false });
  assert.equal(h.render().sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 960 }).sidebarCollapsed, false);
  assert.equal(h.change({ viewportWidth: 1440 }).sidebarCollapsed, false);
});

test("detail width shares available desktop space while preserving the existing 320 minimum", async () => {
  const { resolveDetailWidth } = await harness();
  assert.equal(resolveDetailWidth(1280, 680, false, true), 580);
  assert.equal(resolveDetailWidth(1200, 680, true, true), 680);
  assert.equal(resolveDetailWidth(960, 680, true, true), 532);
  assert.equal(resolveDetailWidth(960, 680, false, true), 320);
  assert.equal(resolveDetailWidth(1440, 360, false, true), 360);
  assert.equal(resolveDetailWidth(1280, 680, false, false), 0);
});

test("responsive detail policy folds overview on the first narrow render without changing a wide initial layout", async () => {
  const { getResponsiveDetailCollapse } = await harness();
  assert.equal(getResponsiveDetailCollapse(960, null, false, false), true);
  assert.equal(getResponsiveDetailCollapse(1079, null, false, false), true);
  assert.equal(getResponsiveDetailCollapse(1080, null, false, false), undefined);
  assert.equal(getResponsiveDetailCollapse(1440, null, false, false), undefined);
});

test("responsive overview policy changes detail visibility only when crossing the 1080 breakpoint", async () => {
  const { getResponsiveDetailCollapse } = await harness();
  assert.equal(getResponsiveDetailCollapse(1079, false, false, false), true);
  assert.equal(getResponsiveDetailCollapse(1080, true, false, false), false);
  assert.equal(getResponsiveDetailCollapse(1440, true, false, false), false);
});

test("stable-width overview renders leave manual detail visibility alone", async () => {
  const { getResponsiveDetailCollapse } = await harness();
  assert.equal(getResponsiveDetailCollapse(960, true, false, false), undefined, "manual expansion at a narrow width is not immediately undone");
  assert.equal(getResponsiveDetailCollapse(1079, true, false, false), undefined);
  assert.equal(getResponsiveDetailCollapse(1280, false, false, false), undefined, "manual folding at a wide width is not immediately undone");
});

test("a manually folded browser stays folded on resize; returning to a narrow overview applies its own policy", async () => {
  const { getResponsiveDetailCollapse } = await harness();
  assert.equal(getResponsiveDetailCollapse(960, null, true, false), undefined, "a selected browser uses the sidebar policy even on initial narrow load");
  assert.equal(getResponsiveDetailCollapse(960, true, true, false), undefined);
  assert.equal(getResponsiveDetailCollapse(1280, true, true, false), undefined, "widening cannot reopen a browser the user folded");
  assert.equal(getResponsiveDetailCollapse(960, false, true, true), undefined);
  assert.equal(getResponsiveDetailCollapse(960, true, false, true), true, "switching from browser to overview at the same narrow width folds overview");
});
