const SIDEBAR_SLIDE_ID = "sidebar-slide";
const SIDEBAR_TOGGLE_STORAGE_KEY = "t3code:sidebar-toggle-style";

const SIDEBAR_TOGGLE_STYLES = ["resize", "slide-all", "snap", "glide", "under"] as const;
type SidebarToggleStyle = (typeof SIDEBAR_TOGGLE_STYLES)[number];
const DEFAULT_SIDEBAR_TOGGLE_STYLE: SidebarToggleStyle = "glide";

function isSidebarToggleStyle(value: string | null): value is SidebarToggleStyle {
  return SIDEBAR_TOGGLE_STYLES.some((style) => style === value);
}

function readSidebarToggleStyle(): SidebarToggleStyle {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_TOGGLE_STYLE;
  const fromUrl = new URLSearchParams(window.location.search).get("sidebarToggle");
  try {
    if (isSidebarToggleStyle(fromUrl)) {
      window.localStorage.setItem(SIDEBAR_TOGGLE_STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    const stored = window.localStorage.getItem(SIDEBAR_TOGGLE_STORAGE_KEY);
    if (isSidebarToggleStyle(stored)) return stored;
  } catch {
    if (isSidebarToggleStyle(fromUrl)) return fromUrl;
  }
  return DEFAULT_SIDEBAR_TOGGLE_STYLE;
}

let currentStyle: SidebarToggleStyle | null = null;

function sidebarToggleStyle(): SidebarToggleStyle {
  const fromUrl =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("sidebarToggle");
  if (currentStyle === null || (isSidebarToggleStyle(fromUrl) && fromUrl !== currentStyle)) {
    currentStyle = readSidebarToggleStyle();
    if (typeof document !== "undefined") {
      document.documentElement.dataset.sidebarToggle = currentStyle;
    }
  }
  return currentStyle;
}

if (typeof document !== "undefined") sidebarToggleStyle();

function sidebarSlideElements(slot: string) {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`[data-panel-animations="true"] [data-slot="${slot}"]`),
  );
}

function slideDuration(element: Element) {
  const duration = Number.parseFloat(
    getComputedStyle(element).getPropertyValue("--panel-animation-duration"),
  );
  return Number.isFinite(duration) ? duration : 0;
}

function slideTiming(element: Element): KeyframeAnimationOptions {
  return { duration: slideDuration(element), easing: "ease-out", id: SIDEBAR_SLIDE_ID };
}

function cancelSidebarSlide(elements: Iterable<Element | null>) {
  for (const element of elements) {
    for (const animation of element?.getAnimations() ?? []) {
      if (animation.id === SIDEBAR_SLIDE_ID) animation.cancel();
    }
  }
}

function siblingSlot(element: Element | null, slot: string): HTMLElement | null {
  return element instanceof HTMLElement && element.dataset.slot === slot ? element : null;
}

function isOpaqueColor(color: string) {
  const alpha = /(?:,|\/)\s*([\d.]+%?)\s*\)$/.exec(color)?.[1];
  return alpha === undefined || Number.parseFloat(alpha) >= (alpha.endsWith("%") ? 100 : 1);
}

function paintAt(container: HTMLElement, x: number, y: number) {
  const element = document
    .elementsFromPoint(x, y)
    .find(
      (candidate) =>
        container.contains(candidate) && isOpaqueColor(getComputedStyle(candidate).backgroundColor),
    );
  const style = getComputedStyle(element ?? container);
  return {
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
    backgroundSize: style.backgroundSize,
  };
}

let sidebarSlidePending = false;

function afterCommit(commit: () => void, measure: () => () => void) {
  if (sidebarSlidePending) {
    commit();
    return;
  }
  const run = measure();
  commit();
  sidebarSlidePending = true;
  window.requestAnimationFrame(() => {
    sidebarSlidePending = false;
    run();
  });
}

function slideAll(commit: () => void) {
  afterCommit(commit, () => {
    const scope = '[data-panel-animations="true"]';
    const containers = document.querySelectorAll<HTMLElement>(
      `${scope} [data-slot="sidebar-container"]`,
    );
    const insets = document.querySelectorAll<HTMLElement>(`${scope} [data-slot="sidebar-inset"]`);
    const targets = [
      ...Array.from(containers, (element) => ({ element, parent: null, inset: false })),
      ...Array.from(insets).flatMap((inset) => [
        { element: inset, parent: null, inset: true },
        ...Array.from(
          inset.querySelectorAll<HTMLElement>("[data-sidebar-slide-children] > *"),
          (element) => ({ element, parent: inset, inset: false }),
        ),
      ]),
    ].map((target) => ({ ...target, start: target.element.getBoundingClientRect().left }));
    return () => {
      const first = targets[0];
      if (!first) return;
      const insetElements = targets.filter(({ inset }) => inset).map(({ element }) => element);
      const anchors = insetElements.flatMap((inset) => [
        ...Array.from(
          inset.querySelectorAll<HTMLElement>("[data-sidebar-slide-hold]"),
          (element) => ({ element, inset, via: null }),
        ),
        ...Array.from(
          inset.querySelectorAll<HTMLElement>(
            "[data-sidebar-slide-children] > * [data-sidebar-slide-stay]",
          ),
          (element) => ({
            element,
            inset,
            via: element.closest<HTMLElement>("[data-sidebar-slide-children] > *"),
          }),
        ),
      ]);
      cancelSidebarSlide([
        ...targets.map(({ element }) => element),
        ...anchors.map(({ element }) => element),
        ...insetElements.flatMap((inset) => [
          inset.previousElementSibling,
          inset.nextElementSibling,
        ]),
      ]);
      const offsets = new Map(
        targets.map(({ element, start }) => [
          element,
          start - element.getBoundingClientRect().left,
        ]),
      );
      const anchorStarts = anchors.map(({ element }) => element.getBoundingClientRect());
      const timing = slideTiming(first.element);
      const slides = new Map<HTMLElement, number>();
      for (const { element, parent, inset } of targets) {
        const ownOffset = offsets.get(element) ?? 0;
        if (parent && Math.abs(ownOffset) < 0.5) continue;
        const offset = ownOffset - (parent ? (offsets.get(parent) ?? 0) : 0);
        if (!element.isConnected || Math.abs(offset) < 0.5) continue;
        if (inset) fillSlideAllEdge(element, offset, timing);
        element.animate({ transform: [`translateX(${offset}px)`, "translateX(0)"] }, timing);
        slides.set(element, offset);
      }
      anchors.forEach(({ element, inset, via }, index) => {
        const start = anchorStarts[index];
        const insetOffset = slides.get(inset) ?? 0;
        const viaOffset = via ? (slides.get(via) ?? 0) : 0;
        if (!start || (via ? viaOffset === 0 : insetOffset === 0)) return;
        const contained = element.getBoundingClientRect();
        const x = start.left - contained.left;
        const y = start.top - contained.top;
        const from = via || insetOffset < 0 ? x + insetOffset : x;
        element.animate(
          {
            transform: [
              `translate(${from}px, ${y}px)`,
              `translate(${x + insetOffset + viaOffset}px, ${y}px)`,
            ],
          },
          timing,
        );
      });
    };
  });
}

function slideAllEdgeRows(inset: HTMLElement, rect: DOMRect, underNotch: boolean) {
  const rows = Array.from(inset.querySelectorAll<HTMLElement>("[data-layout-pane-id]")).flatMap(
    (pane) => {
      const paneRect = pane.getBoundingClientRect();
      if (paneRect.width === 0 || paneRect.right < rect.right - 1 || paneRect.left >= rect.right) {
        return [];
      }
      const notch = underNotch
        ? pane.querySelector<HTMLElement>('[data-pane-notch="right"]')
        : null;
      const top = notch?.offsetWidth ? notch.getBoundingClientRect().bottom : paneRect.top;
      return [{ top: Math.max(top, rect.top), bottom: Math.min(paneRect.bottom, rect.bottom) }];
    },
  );
  return rows.length > 0 ? rows : [{ top: rect.top, bottom: rect.bottom }];
}

function fillSlideAllEdge(inset: HTMLElement, offset: number, timing: KeyframeAnimationOptions) {
  const opening = offset < 0;
  const edge = opening
    ? siblingSlot(inset.previousElementSibling, "sidebar-slide-surface")
    : siblingSlot(inset.nextElementSibling, "sidebar-slide-frame");
  if (!edge) return;
  const rect = inset.getBoundingClientRect();
  edge.style.left = `${opening ? rect.right + offset : rect.right}px`;
  edge.style.width = `${opening ? -offset : window.innerWidth - rect.right}px`;
  edge.replaceChildren(
    ...slideAllEdgeRows(inset, rect, opening).flatMap(({ top, bottom }) => {
      if (opening) {
        const piece = document.createElement("div");
        piece.className = "absolute inset-x-0 rounded-pane bg-background";
        Object.assign(piece.style, { top: `${top}px`, height: `${bottom - top}px` });
        return [piece];
      }
      return (["top", "bottom"] as const).map((corner) => {
        const piece = document.createElement("div");
        piece.dataset.corner = corner;
        piece.style.top = `${corner === "top" ? top : bottom}px`;
        return piece;
      });
    }),
  );
  edge.animate({ opacity: [1, 1] }, timing);
}

function snapInsetVisibleLeft(inset: HTMLElement) {
  const left = inset.getBoundingClientRect().left;
  const surface = siblingSlot(inset.previousElementSibling, "sidebar-slide-surface");
  if (surface?.getAnimations().some((animation) => animation.id === SIDEBAR_SLIDE_ID)) {
    return Math.min(left, surface.getBoundingClientRect().left);
  }
  return left + (parseInsetClip(getComputedStyle(inset).clipPath)?.left ?? 0);
}

function snapEdgeRows(inset: HTMLElement, rect: DOMRect) {
  const notchFeet = Array.from(
    inset.querySelectorAll<HTMLElement>('[data-pane-notch-corner=""]'),
  ).filter(
    (element) =>
      element.offsetWidth > 0 && Math.abs(element.getBoundingClientRect().left - rect.left) <= 1,
  );
  const panes = Array.from(inset.querySelectorAll<HTMLElement>("[data-layout-pane-id]"));
  const rows = (panes.length > 0 ? panes : [inset]).flatMap((pane) => {
    const paneRect = pane.getBoundingClientRect();
    if (paneRect.width === 0 || paneRect.left > rect.left + 1 || paneRect.right <= rect.left) {
      return [];
    }
    const notchFoot = notchFeet.find((element) => {
      const footTop = element.getBoundingClientRect().top;
      return footTop >= paneRect.top - 1 && footTop < paneRect.bottom;
    });
    const top = Math.max(notchFoot?.getBoundingClientRect().top ?? paneRect.top, rect.top);
    const bottom = Math.min(paneRect.bottom, rect.bottom);
    return [{ top, bottom, notchFoot }];
  });
  return rows.length > 0 ? rows : [{ top: rect.top, bottom: rect.bottom, notchFoot: undefined }];
}

function snap(commit: () => void) {
  afterCommit(commit, () => {
    const containers = sidebarSlideElements("sidebar-container").map((element) => ({
      element,
      start: element.getBoundingClientRect().left,
    }));
    const insets = sidebarSlideElements("sidebar-inset").map((element) => ({
      element,
      start: snapInsetVisibleLeft(element),
    }));
    return () => {
      const first = containers[0];
      if (!first) return;
      cancelSidebarSlide([
        ...containers.map(({ element }) => element),
        ...insets.flatMap(({ element }) => [
          element,
          siblingSlot(element.previousElementSibling, "sidebar-slide-surface"),
          ...element.querySelectorAll('[data-pane-notch-corner=""]'),
        ]),
      ]);
      const timing = slideTiming(first.element);
      for (const { element, start } of containers) {
        const offset = start - element.getBoundingClientRect().left;
        if (!element.isConnected || Math.abs(offset) < 0.5) continue;
        element.animate({ transform: [`translateX(${offset}px)`, "translateX(0)"] }, timing);
      }
      for (const { element, start } of insets) {
        const offset = element.getBoundingClientRect().left - start;
        if (!element.isConnected || Math.abs(offset) < 0.5) continue;
        if (offset < 0) {
          const rect = element.getBoundingClientRect();
          const radius = getComputedStyle(element).borderBottomLeftRadius;
          const clip = (left: number) =>
            `inset(${-rect.top}px ${rect.right - window.innerWidth}px 0 ${left}px round 0 0 ${radius} ${radius})`;
          element.animate({ clipPath: [clip(-offset), clip(0)] }, timing);
          continue;
        }
        const surface = siblingSlot(element.previousElementSibling, "sidebar-slide-surface");
        if (!surface) continue;
        const rect = element.getBoundingClientRect();
        const radius = Number.parseFloat(getComputedStyle(element).borderBottomLeftRadius) || 0;
        surface.style.left = `${rect.left - offset}px`;
        surface.style.width = `${offset + radius}px`;
        const rows = snapEdgeRows(element, rect);
        surface.replaceChildren(
          ...rows.map(({ top, bottom }) => {
            const piece = document.createElement("div");
            piece.className = "absolute inset-x-0 rounded-pane";
            Object.assign(piece.style, {
              top: `${top}px`,
              height: `${bottom - top}px`,
              ...paintAt(element, rect.left + 2, top + 2),
            });
            return piece;
          }),
        );
        for (const { notchFoot } of rows) {
          notchFoot?.animate({ visibility: ["hidden", "hidden"] }, timing);
        }
        surface.animate(
          { opacity: [1, 1], transform: ["translateX(0)", `translateX(${offset}px)`] },
          timing,
        );
      }
    };
  });
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function parseInsetClip(value: string) {
  const body = /inset\(([^)]*)\)/.exec(value)?.[1];
  if (!body) return null;
  const sides = (body.split(" round ")[0] ?? "")
    .trim()
    .split(/\s+/)
    .map((side) => Number.parseFloat(side));
  const [top = 0, right = top, bottom = top, left = right] = sides.map((side) =>
    Number.isFinite(side) ? side : 0,
  );
  return { top, right, bottom, left };
}

function visualBox(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  const clip = element.getAnimations().some((animation) => animation.id === SIDEBAR_SLIDE_ID)
    ? parseInsetClip(getComputedStyle(element).clipPath)
    : null;
  if (!clip) return rect;
  return {
    left: rect.left + clip.left,
    right: rect.right - clip.right,
    top: rect.top + clip.top,
    bottom: rect.bottom - clip.bottom,
  };
}

function isOnScreen(rect: Box) {
  return (
    rect.right - rect.left > 0 &&
    rect.bottom - rect.top > 0 &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function textLeft(node: Text, range: Range) {
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 ? rect.left : null;
}

function leftmostText(area: HTMLElement): Text | null {
  const box = area.getBoundingClientRect();
  const top = Math.max(box.top, 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let best: { node: Text; left: number } | null = null;
  let seen = 0;
  for (let node = walker.nextNode(); node && seen < 80; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data.trim()) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.bottom < top || rect.top > bottom) continue;
    if (rect.left < box.left - 1 || rect.right > box.right + 1) continue;
    seen += 1;
    if (!best || rect.left < best.left - 0.5) best = { node, left: rect.left };
  }
  return best?.node ?? null;
}

const FLIP_ANCHORS =
  '[data-pane-notch], [data-workspace-titlebar-controls], [data-workspace-area]:not([data-workspace-area="tabs"])';

interface FlipAnchor {
  readonly element: HTMLElement;
  readonly start: Box;
  readonly text: Text | null;
  readonly textStart: number | null;
}

interface FlipBlock {
  readonly element: HTMLElement;
  readonly start: Box;
  readonly anchors: readonly FlipAnchor[];
}

function flipAnchors(block: HTMLElement): FlipAnchor[] {
  const range = document.createRange();
  const found = Array.from(block.querySelectorAll<HTMLElement>(FLIP_ANCHORS));
  const elements = found.length > 0 ? found : Array.from(block.children);
  return elements.flatMap((element) => {
    if (!(element instanceof HTMLElement)) return [];
    const start = element.getBoundingClientRect();
    if (!isOnScreen(start)) return [];
    const text =
      element.matches("[data-workspace-area]") || found.length === 0 ? leftmostText(element) : null;
    return [{ element, start, text, textStart: text ? textLeft(text, range) : null }];
  });
}

function flipBlocks(insets: readonly HTMLElement[]): FlipBlock[] {
  return insets.flatMap((inset) => {
    const panes = Array.from(inset.querySelectorAll<HTMLElement>("[data-layout-pane-id]")).filter(
      (pane) => isOnScreen(pane.getBoundingClientRect()),
    );
    const blocks = panes.length > 0 ? panes : [inset];
    return [
      ...(panes.length > 0 ? [{ element: inset, start: visualBox(inset), anchors: [] }] : []),
      ...blocks.map((element) => ({
        element,
        start: visualBox(element),
        anchors: flipAnchors(element),
      })),
    ];
  });
}

interface FlipOverride {
  readonly element: HTMLElement;
  readonly property: "overflow" | "visibility" | "anchor-name";
  readonly value: string;
}

let flipOverrides: FlipOverride[] = [];
let flipFills: HTMLElement[] = [];
let flipSession = 0;

function overrideStyle(element: HTMLElement, property: FlipOverride["property"], value: string) {
  if (
    flipOverrides.some((override) => override.element === element && override.property === property)
  ) {
    return;
  }
  flipOverrides.push({ element, property, value: element.style.getPropertyValue(property) });
  element.style.setProperty(property, value);
}

function restoreFlip() {
  for (const { element, property, value } of flipOverrides) {
    if (value) element.style.setProperty(property, value);
    else element.style.removeProperty(property);
  }
  for (const fill of flipFills) fill.remove();
  flipOverrides = [];
  flipFills = [];
}

function openClipsBetween(from: HTMLElement, to: HTMLElement) {
  for (
    let element: HTMLElement | null = from.parentElement;
    element;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);
    const clips = [style.overflowX, style.overflowY].some(
      (value) => value === "hidden" || value === "clip",
    );
    if (clips && element.scrollLeft === 0 && element.scrollTop === 0) {
      overrideStyle(element, "overflow", "visible");
    }
    if (element === to) break;
  }
}

function radii(element: HTMLElement) {
  const style = getComputedStyle(element);
  return [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ]
    .map((radius) => `${Number.parseFloat(radius) || 0}px`)
    .join(" ");
}

function boxClip(box: Box, visual: Box, round: string) {
  return `inset(${visual.top - box.top}px ${box.right - visual.right}px ${box.bottom - visual.bottom}px ${visual.left - box.left}px round ${round})`;
}

function addFill(block: HTMLElement, box: DOMRect, start: Box, timing: KeyframeAnimationOptions) {
  const reach = Math.ceil(
    Math.max(box.left - start.left, start.right - box.right, box.top - start.top, 0),
  );
  if (reach < 1) return null;
  const own = getComputedStyle(block);
  const paint = isOpaqueColor(own.backgroundColor)
    ? {
        backgroundColor: own.backgroundColor,
        backgroundImage: own.backgroundImage,
        backgroundSize: own.backgroundSize,
      }
    : block.matches('[data-slot="sidebar-inset"]')
      ? null
      : paintAt(block, box.left + 2, box.bottom - 2);
  if (!paint || !isOpaqueColor(paint.backgroundColor)) return null;
  const fill = document.createElement("div");
  fill.setAttribute("aria-hidden", "true");
  fill.dataset.sidebarFlipFill = "";
  Object.assign(fill.style, {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: `${-reach}px`,
    right: `${-reach}px`,
    zIndex: "-1",
    opacity: "0",
    pointerEvents: "none",
    ...paint,
  });
  block.append(fill);
  flipFills.push(fill);
  return fill.animate({ opacity: [1, 1] }, timing);
}

function flip(commit: () => void, mode: "glide" | "under") {
  afterCommit(commit, () => {
    const sidebars = sidebarSlideElements("sidebar-container").map((element) => ({
      element,
      start: element.getBoundingClientRect(),
      visual: visualBox(element),
    }));
    const insets = sidebarSlideElements("sidebar-inset");
    const blocks = flipBlocks(insets);
    return () => {
      const first = sidebars[0];
      if (!first) return;
      const session = ++flipSession;
      cancelSidebarSlide([
        ...sidebars.map(({ element }) => element),
        ...blocks.flatMap(({ element, anchors }) => [
          element,
          ...anchors.map((anchor) => anchor.element),
          ...element.querySelectorAll("[data-pane-cut], [data-pane-notch-corner]"),
        ]),
      ]);
      restoreFlip();
      const timing = slideTiming(first.element);
      if (!timing.duration) return;
      const animations: Animation[] = [];
      const range = document.createRange();

      for (const { element, start, visual } of sidebars) {
        if (!element.isConnected) continue;
        const box = element.getBoundingClientRect();
        if (mode === "glide") {
          const offset = start.left - box.left;
          if (Math.abs(offset) < 0.5) continue;
          animations.push(
            element.animate({ transform: [`translateX(${offset}px)`, "translateX(0)"] }, timing),
          );
          continue;
        }
        const opening =
          element.closest<HTMLElement>('[data-slot="sidebar"]')?.dataset.state === "expanded";
        const open = opening ? box : start;
        const shift = open.left - box.left;
        const width = open.right - open.left;
        const from = Math.max(0, Math.min(width, open.right - visual.right));
        const to = opening ? 0 : width;
        if (Math.abs(from - to) < 0.5) continue;
        animations.push(
          element.animate(
            {
              transform: [`translateX(${shift}px)`, `translateX(${shift}px)`],
              clipPath: [`inset(0 ${from}px 0 0)`, `inset(0 ${to}px 0 0)`],
            },
            timing,
          ),
        );
      }

      const moving = blocks.flatMap((block) => {
        if (!block.element.isConnected) return [];
        const box = block.element.getBoundingClientRect();
        const still =
          Math.abs(box.left - block.start.left) < 0.5 &&
          Math.abs(box.right - block.start.right) < 0.5;
        return still ? [] : [{ ...block, box }];
      });
      const deltas = new Map<HTMLElement, number>();
      for (const { box, anchors } of moving) {
        for (const anchor of anchors) {
          const { element } = anchor;
          if (!element.isConnected) continue;
          const end = element.getBoundingClientRect();
          const textEnd = anchor.text?.isConnected ? textLeft(anchor.text, range) : null;
          let delta: number;
          if (anchor.textStart !== null && textEnd !== null) delta = anchor.textStart - textEnd;
          else if (Math.abs(end.left - box.left) <= Math.abs(box.right - end.right))
            delta = anchor.start.left - end.left;
          else delta = anchor.start.right - end.right;
          deltas.set(element, delta);
        }
      }

      for (const block of moving) {
        const { element, box, start } = block;
        for (const anchor of block.anchors) {
          if (deltas.has(anchor.element)) openClipsBetween(anchor.element, element);
        }
        const inset = element.closest<HTMLElement>('[data-slot="sidebar-inset"]');
        if (inset && inset !== element) openClipsBetween(element, inset);
        if (getComputedStyle(element).overflowX !== "visible") {
          overrideStyle(element, "overflow", "visible");
        }
        const fill = addFill(element, box, start, timing);
        if (fill) animations.push(fill);
      }

      for (const { element, box, start } of moving) {
        const round = radii(element);
        animations.push(
          element.animate(
            { clipPath: [boxClip(box, start, round), boxClip(box, box, round)] },
            timing,
          ),
        );
        for (const cut of element.querySelectorAll<HTMLElement>(
          ":scope > [data-pane-cut], [data-pane-notch-corner]",
        )) {
          overrideStyle(cut, "visibility", "hidden");
        }
        for (const notch of element.querySelectorAll<HTMLElement>('[data-pane-notch=""]')) {
          overrideStyle(notch, "anchor-name", "none");
        }
      }

      for (const [element, delta] of deltas) {
        let parent = element.parentElement;
        let parentDelta = 0;
        while (parent) {
          const value = deltas.get(parent);
          if (value !== undefined) {
            parentDelta = value;
            break;
          }
          parent = parent.parentElement;
        }
        const offset = delta - parentDelta;
        if (Math.abs(offset) < 0.5) continue;
        animations.push(
          element.animate(
            getComputedStyle(element).transform === "none"
              ? { transform: [`translateX(${offset}px)`, "translateX(0)"] }
              : { translate: [`${offset}px 0`, "0 0"] },
            timing,
          ),
        );
      }

      void Promise.all(animations.map((animation) => animation.finished)).then(
        () => {
          if (session === flipSession) restoreFlip();
        },
        () => undefined,
      );
    };
  });
}

export function animateSidebarToggle(commit: () => void) {
  const style = sidebarToggleStyle();
  if (style === "resize") commit();
  else if (style === "slide-all") slideAll(commit);
  else if (style === "snap") snap(commit);
  else flip(commit, style);
}
