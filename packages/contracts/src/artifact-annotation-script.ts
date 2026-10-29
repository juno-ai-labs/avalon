import { ANNOTATION_CONTEXT_CHARACTERS } from './annotation-context';

/**
 * The one annotation script every HTML surface runs: the picker, the comment
 * cards and the saved-selection highlight, behind one in-page API.
 *
 * A leaf module on purpose: the Vite plugins that emit this script for the app
 * origins import it from their config files, so it must pull in nothing but
 * the context budget. The message schemas live in `artifact-picker.ts`.
 *
 * It is a string rather than a module because it runs inside documents Rally
 * does not bundle: a live artifact's page (served by the artifact Worker), the
 * opaque `srcdoc` frame for an HTML file, and the desktop's artifact view. Each
 * host gets it there its own way and then calls `globalThis.rallyAnnotations`
 * directly (the desktop, through `executeJavaScript`) or through the
 * `postMessage` bridge it installs when it has a parent (the browser client and
 * the opaque frame). See `docs/artifact-annotations.md`.
 */

/** Shared normalization for live picking and deterministic revision matching. */
export function artifactElementHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,[data-rally-picker]').forEach((node) => node.remove());
  for (const node of [clone, ...Array.from(clone.querySelectorAll('*'))]) for (const attr of Array.from(node.attributes)) {
    if (attr.name.startsWith('on') || attr.name === 'd' || attr.value.trim().startsWith('data:')) node.removeAttribute(attr.name);
  }
  return clone.outerHTML.replace(/\s+/gu, ' ').trim();
}
const ARTIFACT_ELEMENT_HTML_SOURCE = `(${artifactElementHtml.toString()})`;
/** Context next to the selection, excluding executable and styling content. */
export function artifactElementContext(element: Element | null, before: boolean, limit: number): string {
  if (!element || element.matches('script,style,[data-rally-picker]')) return '';
  const clone = element.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,[data-rally-picker]').forEach((node) => node.remove());
  const text = clone.textContent ?? '';
  return before ? text.slice(-limit) : text.slice(0, limit);
}
const ARTIFACT_ELEMENT_CONTEXT_SOURCE = `(${artifactElementContext.toString()})`;
/** Tabler pointer-collaboration, MIT. Hotspot matches the pointer tip. */
export const ARTIFACT_COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.943 13.013l5.016 -1.957c1.445 -.563 1.367 -2.633 -.116 -3.087l-12.727 -3.895c-1.253 -.384 -2.426 .79 -2.042 2.042l3.895 12.727c.454 1.483 2.524 1.56 3.087 .116l1.957 -5.017c.166 -.426 .503 -.763 .93 -.929"/><path d="M20 15l-3.151 1.064a1.25 1.25 0 0 0 -.785 .785l-1.064 3.151" fill="none"/></svg>')}") 4 4, crosshair`;

/**
 * Confirmed comment cards, drawn beside their elements and kept there through
 * scrolling and layout changes by the tracker. Each card comes with an outline
 * around the element it is about, so the comment's scope is visible, and the
 * outline strengthens while the card is hovered. A card sits to the right of
 * its element with a connector when there is room, else below it, and both
 * hide while the element is out of the viewport. `report` gets edit and
 * remove clicks.
 */
const ARTIFACT_COMMENTS_SOURCE = String.raw`(function(pins,report) {
  const entries=[];
  for(const pin of pins) {
    const annotation=pin.annotation, locator=annotation.target.locator;
    if(locator.type!=='element' || !annotation.comment.trim())continue;
    if(locator.pagePath && locator.pagePath!==location.pathname+location.search)continue;
    let element;try{element=document.querySelector(locator.css);}catch{continue;}
    if(!element || ${ARTIFACT_ELEMENT_HTML_SOURCE}(element)!==annotation.content.exact)continue;
    const host=document.createElement('div');host.setAttribute('data-rally-picker','');
    host.style.cssText='position:fixed;z-index:2147483646;box-sizing:border-box;width:292px;display:none';
    const shadow=host.attachShadow({mode:'closed'});
    const style=document.createElement('style');
    style.textContent=':host{all:initial}aside{position:relative;box-sizing:border-box;padding:12px 34px 12px 12px;background:#fcfcfc;color:#1f1f1f;border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 8px 26px rgba(30,28,22,.16);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}aside.beside::before{content:"";position:absolute;top:12px;right:100%;width:12px;border-top:1.5px solid #3b82f6}button{border:0;background:none;color:inherit;cursor:pointer;font:inherit;padding:0;margin:0}.comment{display:block;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;width:100%;border-radius:4px}.comment:hover{color:#2563eb}.remove{position:absolute;right:8px;top:6px;width:24px;height:24px;border-radius:6px;font-size:18px;line-height:24px;color:#6b6b6b}.remove:hover{background:rgba(0,0,0,.06);color:#1f1f1f}';
    const card=document.createElement('aside');card.setAttribute('aria-label','Pinned comment');
    const comment=document.createElement('button');comment.className='comment';comment.textContent=annotation.comment;comment.setAttribute('aria-label','Edit comment');
    const remove=document.createElement('button');remove.className='remove';remove.textContent='×';remove.setAttribute('aria-label','Remove comment');
    for(const [button,action] of [[comment,'edit'],[remove,'remove']])button.addEventListener('click',event=>{event.stopPropagation();if(event.isTrusted){const r=element.getBoundingClientRect();report({id:pin.id,action,point:{x:r.right,y:r.top}});}});
    card.append(comment,remove);shadow.append(style,card);
    const outline=document.createElement('div');outline.setAttribute('data-rally-picker','');
    outline.style.cssText='position:fixed;pointer-events:none;z-index:2147483644;box-sizing:border-box;border-radius:6px;display:none;border:1.5px solid rgba(59,130,246,.75);background:rgba(59,130,246,.06);transition:border-color .12s,background-color .12s,box-shadow .12s';
    const emphasis=(on)=>{outline.style.borderColor=on?'#2563eb':'rgba(59,130,246,.75)';outline.style.backgroundColor=on?'rgba(37,99,235,.10)':'rgba(59,130,246,.06)';outline.style.boxShadow=on?'0 0 0 3px rgba(59,130,246,.18)':'none';};
    card.addEventListener('mouseenter',()=>emphasis(true));card.addEventListener('mouseleave',()=>emphasis(false));
    document.documentElement.append(outline,host);
    const entry={element,host,outline,card,update:()=>layout()};
    entries.push(entry);
  }
  // One pass for every card, so none covers another card or another
  // commented element: cards go beside their element when the viewport has
  // room, below it otherwise, and slide down past whatever is in the way.
  function layout(){
    const edge=document.documentElement.clientWidth||innerWidth;
    const items=entries.map(e=>({e,r:e.element.getBoundingClientRect()}));
    items.sort((a,b)=>a.r.top-b.r.top||a.r.left-b.r.left);
    const elements=new Map();
    for(const {e,r} of items) if(visible(e.element,r)) elements.set(e,{left:r.left,top:r.top,right:r.right,bottom:r.bottom});
    const placed=[];
    const overlaps=(b,o)=>b.left<o.right&&b.right>o.left&&b.top<o.bottom&&b.bottom>o.top;
    for(const {e,r} of items){
      if(!elements.has(e)){e.host.style.display='none';e.outline.style.display='none';continue;}
      e.outline.style.display='block';
      Object.assign(e.outline.style,{left:r.x+'px',top:r.y+'px',width:r.width+'px',height:r.height+'px'});
      const room=edge-8-(r.right+12);
      const beside=room>=180;
      const width=beside?Math.min(292,room):292;
      e.host.style.width=width+'px';
      e.host.style.display='block';
      const height=e.host.offsetHeight||48;
      const left=beside?r.right+12:Math.max(8,Math.min(r.left,edge-300));
      let top=beside?r.top:r.bottom+8;
      const blockers=[...placed,...[...elements].filter(([other])=>other!==e).map(([,box])=>box)];
      for(let guard=0;guard<12;guard++){
        const box={left,top,right:left+width,bottom:top+height};
        const hit=blockers.filter(o=>overlaps(box,o)).sort((a,b)=>a.bottom-b.bottom)[0];
        if(!hit)break;
        top=hit.bottom+6;
      }
      e.card.className=beside&&top===r.top?'beside':'below';
      e.host.style.left=left+'px';e.host.style.top=top+'px';
      placed.push({left,top,right:left+width,bottom:top+height});
    }
  }
  entries.forEach(track);
  return ()=>{entries.forEach((entry)=>{untrack(entry);entry.host.remove();entry.outline.remove();});};
})`;

/**
 * The element inspector: outline, grow, pin. `report` gets each pin, and
 * `null` on Escape. The outline follows the hovered block through scrolling
 * and layout changes, re-resolves what is under the pointer after a scroll,
 * and never offers the document or its body as a target.
 */
const ARTIFACT_PICKER_SOURCE = String.raw`(function(report) {
  const cursor = document.createElement('style');
  cursor.setAttribute('data-rally-picker', '');
  cursor.textContent = '* { cursor: ${ARTIFACT_COMMENT_CURSOR} !important; }';
  document.documentElement.append(cursor);
  const outline = document.createElement('div');
  outline.setAttribute('data-rally-picker', '');
  outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;border-radius:6px;background:rgba(59,130,246,.07);box-shadow:0 0 0 4px rgba(59,130,246,.16);display:none;box-sizing:border-box;transition:left .06s ease-out,top .06s ease-out,width .06s ease-out,height .06s ease-out';
  document.documentElement.append(outline);
  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,td,th,tr,button,a,input,select,textarea,label,img,svg,video,figure,pre,blockquote,table,article,section,header,footer,nav,aside,main,div';
  let target = null;
  let leaf = null;
  let last = null;
  const entry = { element: null, update: (r) => { Object.assign(outline.style, { left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px' }); } };
  function pickable(element) {
    return element instanceof Element && element !== document.body && element !== document.documentElement && !element.closest('[data-rally-picker]');
  }
  function show(element) {
    if (element && !pickable(element)) element = null;
    target = element;
    if (entry.element) untrack(entry);
    if (!element) { outline.style.display = 'none'; return; }
    entry.element = element;
    const r = element.getBoundingClientRect();
    outline.style.transition = 'none';
    entry.update(r);
    outline.style.display = 'block';
    void outline.offsetWidth;
    outline.style.transition = '';
    track(entry);
  }
  function resolve(element, grow) {
    if (!pickable(element)) { leaf = null; show(null); return; }
    const found = element.closest(BLOCKS) || element;
    if (!pickable(found)) { leaf = null; show(null); return; }
    if (found !== leaf) { leaf = found; show(grow && pickable(found.parentElement) ? found.parentElement : found); }
  }
  function move(e) {
    if (!e.isTrusted) return;
    last = { x: e.clientX, y: e.clientY };
    resolve(e.target, e.altKey);
  }
  function pin(e) {
    if (!e.isTrusted) return;
    if (e.target instanceof Element && e.target.closest('[data-rally-picker]')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!target) return;
    const element = target;
    const selected = window.getSelection()?.toString() || '';
    const path = [];
    let node = element;
    while (node && node !== document.documentElement) {
      const siblings = node.parentElement ? [...node.parentElement.children].filter(n => n.tagName === node.tagName) : [];
      path.unshift(node.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(node)+1)+')');
      node = node.parentElement;
    }
    const r = element.getBoundingClientRect();
    const width = Math.max(document.documentElement.scrollWidth,innerWidth);
    const height = Math.max(document.documentElement.scrollHeight,innerHeight);
    const x = Math.min(1,Math.max(0,(r.x+scrollX)/width));
    const y = Math.min(1,Math.max(0,(r.y+scrollY)/height));
    selectElement(element);
    // The window the person is looking at, so an agent with no screenshot can
    // rebuild the same view in its own browser.
    const viewport={width:innerWidth,height:innerHeight,scrollX:Math.max(0,scrollX),scrollY:Math.max(0,scrollY),devicePixelRatio:devicePixelRatio||1,colorScheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'};
    report({ point:{x:Math.max(0,e.clientX),y:Math.max(0,e.clientY)}, rect:{x:r.x,y:r.y,width:r.width,height:r.height}, viewport, css:path.join(' > '), box:{x,y,w:Math.max(0,Math.min(1-x,r.width/width)),h:Math.max(0,Math.min(1-y,r.height/height))},visibleText:selected || element.textContent || '',html:trim(element),before:${ARTIFACT_ELEMENT_CONTEXT_SOURCE}(element.previousElementSibling,true,${ANNOTATION_CONTEXT_CHARACTERS}),after:${ARTIFACT_ELEMENT_CONTEXT_SOURCE}(element.nextElementSibling,false,${ANNOTATION_CONTEXT_CHARACTERS}),pagePath:location.pathname+location.search,replace:e.detail>1 });
  }
  function trim(element) { return ${ARTIFACT_ELEMENT_HTML_SOURCE}(element); }
  function double(e) { pin(e); }
  function key(e) {
    if (!e.isTrusted || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { cleanup(); report(null); }
    if (e.key === 'Alt' && target && pickable(target.parentElement)) show(target.parentElement);
    if (e.key === 'ArrowUp' && target && pickable(target.parentElement)) { e.preventDefault(); show(target.parentElement); }
    if (e.key === 'ArrowDown' && target && leaf) {
      e.preventDefault(); let child=leaf;
      while(child.parentElement && child.parentElement!==target && child!==target) child=child.parentElement;
      show(child);
    }
  }
  function scroll() {
    // The page moved under a still pointer: re-resolve what is beneath it.
    if (!last) return;
    const under = document.elementFromPoint(last.x, last.y);
    if (under) resolve(under, false);
  }
  function cleanup() {
    cursor.remove(); outline.remove(); if (entry.element) untrack(entry); document.removeEventListener('mousemove',move,true); document.removeEventListener('click',pin,true); document.removeEventListener('dblclick',double,true); document.removeEventListener('keydown',key,true); document.removeEventListener('scroll',scroll,true);
  }
  document.addEventListener('mousemove',move,true); document.addEventListener('click',pin,true); document.addEventListener('dblclick',double,true); document.addEventListener('keydown',key,true); document.addEventListener('scroll',scroll,true);
  return cleanup;
})`;

/** Highlight only a verified element; resolves whether one was found. */
const ARTIFACT_RESTORE_SOURCE = String.raw`(function(locator,exact){return new Promise(resolve=>{function restore(){let match=null;try{const node=document.querySelector(locator.css);if(node){if(${ARTIFACT_ELEMENT_HTML_SOURCE}(node)===exact && (node.textContent||'').includes(locator.visibleText)){match=node;selectElement(node);node.scrollIntoView({block:'center'});}}}catch{}resolve(!!match);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',restore,{once:true});else restore();});})`;

/**
 * Installs `globalThis.rallyAnnotations`, the API every host calls:
 *
 * - `pick()` starts the inspector if it is not running and resolves with the
 *   next pin, or `null` once the person presses Escape. Pins made before a
 *   host asks are queued, so a quick second click is not lost. The pinned
 *   element stays highlighted as the selection until the host says otherwise.
 * - `stopPicking()` removes the inspector and resolves a waiting `pick()` with
 *   `null`.
 * - `comments(pins, selected)` replaces the cards, keeps `selected` (a CSS
 *   path, or `null`) highlighted as the selection being commented on, and
 *   resolves with the first edit or remove click, or `null` when the cards are
 *   replaced or there are none.
 * - `restore(locator, exact)` highlights a saved selection, after the document
 *   has parsed, and resolves whether it was found.
 * - `rect(css)` is an element's viewport rectangle, for the desktop's crop.
 * - `watchAnchor(callback)` reports the selection's rectangle whenever it
 *   moves, for a host that draws its editor beside it.
 *
 * Everything drawn is kept in place by one tracker: a frame-synced loop that
 * runs only while something is on screen and repositions what moved, so an
 * outline, a selection or a card follows a scroll in any container, a resize,
 * a transition or a layout shift without a listener for each.
 *
 * Installed once per document: a second evaluation keeps the first API.
 */
const ARTIFACT_ANNOTATION_API_SOURCE = String.raw`(function(){
  if (globalThis.rallyAnnotations) return globalThis.rallyAnnotations;
  const tracked = new Set();
  let frame = 0;
  function tick() {
    frame = 0;
    for (const entry of tracked) {
      const r = entry.element.getBoundingClientRect();
      const key = r.x + ',' + r.y + ',' + r.width + ',' + r.height + ',' + innerWidth + ',' + innerHeight + ',' + entry.element.isConnected;
      if (key !== entry.key) { entry.key = key; entry.update(r); }
    }
    if (tracked.size) frame = requestAnimationFrame(tick);
  }
  function track(entry) { entry.key = null; tracked.add(entry); if (!frame) frame = requestAnimationFrame(tick); }
  function untrack(entry) { tracked.delete(entry); entry.element = null; }
  // Whether any of the element's rectangle can be seen: inside the viewport,
  // and not scrolled or clipped out of an ancestor that cuts its overflow.
  function visible(element, r) {
    if (!element.isConnected || innerWidth <= 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflow;
      if (overflow === 'visible') continue;
      const c = node.getBoundingClientRect();
      if (r.bottom < c.top || r.top > c.bottom || r.right < c.left || r.left > c.right) return false;
    }
    return true;
  }
  const selection = document.createElement('div');
  selection.setAttribute('data-rally-picker', '');
  selection.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #2563eb;border-radius:6px;background:rgba(37,99,235,.10);display:none;box-sizing:border-box';
  let anchorWatcher = null;
  const selected = { element: null, update: (r) => {
    const shown = selection.parentNode && r.width + r.height > 0 && visible(selected.element, r);
    selection.style.display = shown ? 'block' : 'none';
    Object.assign(selection.style, { left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px' });
    anchorWatcher?.({ x: r.x, y: r.y, width: r.width, height: r.height });
  } };
  function selectElement(element) {
    if (selected.element) untrack(selected);
    if (!element) { selection.remove(); selection.style.display = 'none'; return; }
    if (!selection.parentNode) document.documentElement.append(selection);
    selected.element = element;
    track(selected);
  }
  const picking = { queue: [], waiter: null, cleanup: null };
  let clearComments = null;
  const api = {
    pick() {
      return new Promise(resolve => {
        if (!picking.cleanup) {
          picking.cleanup = ${ARTIFACT_PICKER_SOURCE}(pin => {
            if (pin === null) picking.cleanup = null;
            if (picking.waiter) { const answer = picking.waiter; picking.waiter = null; answer(pin); } else picking.queue.push(pin);
          });
        }
        if (picking.queue.length) resolve(picking.queue.shift()); else picking.waiter = resolve;
      });
    },
    stopPicking() {
      picking.cleanup?.(); picking.cleanup = null; picking.queue.length = 0;
      const waiter = picking.waiter; picking.waiter = null; waiter?.(null);
    },
    comments(pins, selectedCss) {
      return new Promise(resolve => {
        clearComments?.();
        let element = null;
        if (typeof selectedCss === 'string') { try { element = document.querySelector(selectedCss); } catch {} }
        selectElement(element);
        const cleanup = ${ARTIFACT_COMMENTS_SOURCE}(pins, resolve);
        clearComments = () => { cleanup(); resolve(null); };
        if (!pins.length) resolve(null);
      });
    },
    restore(locator, exact) { return ${ARTIFACT_RESTORE_SOURCE}(locator, exact); },
    rect(css) {
      let node = null; try { node = document.querySelector(css); } catch {}
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    },
    watchAnchor(callback) { anchorWatcher = callback; },
  };
  Object.defineProperty(globalThis, 'rallyAnnotations', { value: api, configurable: true });
  return api;
})()`;

/**
 * The `postMessage` bridge a framed document installs: a parent that cannot
 * call the API sends `rally-annotation-picking`, `rally-annotation-comments`
 * and `rally-annotation-restore`, and gets `rally-annotation-ready`,
 * `rally-artifact-pin`, `rally-annotation-comment-action` and
 * `rally-annotation-restored` back. With a `parentOrigin`, only a parent at
 * that origin is heard and answered; without one (the opaque file frame, whose
 * parent is the app that wrote it) any parent is.
 */
function artifactAnnotationBridgeSource(parentOrigin: string | null): string {
  const origin = JSON.stringify(parentOrigin);
  return String.raw`(function(api){
  if (window.parent === window) return;
  const parentOrigin = ${origin};
  const target = parentOrigin ?? '*';
  const post = (message) => window.parent.postMessage(message, target);
  let session = 0;
  async function pickLoop(id) {
    while (session === id) {
      const pin = await api.pick();
      if (session !== id) return;
      post({ type: 'rally-artifact-pin', pin });
      if (pin === null) return;
    }
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || (parentOrigin !== null && event.origin !== parentOrigin)) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rally-annotation-picking') {
      session += 1;
      if (message.on) void pickLoop(session); else api.stopPicking();
    } else if (message.type === 'rally-annotation-comments') {
      void api.comments(Array.isArray(message.pins) ? message.pins : [], typeof message.selected === 'string' ? message.selected : null).then(action => { if (action) post({ type: 'rally-annotation-comment-action', action }); });
    } else if (message.type === 'rally-annotation-restore') {
      void api.restore(message.locator, message.exact).then(resolved => post({ type: 'rally-annotation-restored', resolved }));
    }
  });
  api.watchAnchor((rect) => post({ type: 'rally-annotation-anchor', rect }));
  post({ type: 'rally-annotation-ready', pagePath: location.pathname + location.search });
})`;
}

/**
 * The whole script for one host. `parentOrigin` is the only origin whose
 * `postMessage` the bridge accepts: the browser client's, for a live artifact
 * the artifact Worker serves; `null` for the opaque file frame.
 */
export function artifactAnnotationScript(parentOrigin: string | null): string {
  return `${artifactAnnotationBridgeSource(parentOrigin)}(${ARTIFACT_ANNOTATION_API_SOURCE});`;
}

/**
 * A short content hash so the served file's path changes when the script does.
 * FNV-1a, because it is synchronous and a cache key needs no more.
 */
export function artifactAnnotationScriptVersion(parentOrigin: string | null): string {
  let hash = 0x811c9dc5;
  for (const character of artifactAnnotationScript(parentOrigin)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The artifact Worker's own path for the script; the hash only busts caches. */
export const ARTIFACT_ANNOTATION_SCRIPT_PATH_PATTERN = /^\/__rally\/picker-[0-9a-f]{8}\.js$/u;
export function artifactAnnotationScriptPath(parentOrigin: string | null): string {
  return `/__rally/picker-${artifactAnnotationScriptVersion(parentOrigin)}.js`;
}
