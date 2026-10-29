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

/** Confirmed comment cards, drawn beside their elements; `report` gets edit and remove clicks. */
const ARTIFACT_COMMENTS_SOURCE = String.raw`(function(pins,report) {
  const entries=[];
  for(const pin of pins) {
    const annotation=pin.annotation, locator=annotation.target.locator;
    if(locator.type!=='element' || !annotation.comment.trim())continue;
    if(locator.pagePath && locator.pagePath!==location.pathname+location.search)continue;
    let element;try{element=document.querySelector(locator.css);}catch{continue;}
    if(!element || ${ARTIFACT_ELEMENT_HTML_SOURCE}(element)!==annotation.content.exact)continue;
    const host=document.createElement('div');host.setAttribute('data-rally-picker','');
    host.style.cssText='position:fixed;z-index:2147483647;box-sizing:border-box;width:292px';
    const shadow=host.attachShadow({mode:'closed'});
    const style=document.createElement('style');
    style.textContent=':host{all:initial}aside{position:relative;box-sizing:border-box;padding:12px 34px 12px 12px;background:#303030;color:#fff;border:1px solid #555;border-radius:12px;box-shadow:0 10px 30px #0004;font:14px/1.4 system-ui}button{border:0;background:none;color:inherit;cursor:pointer;font:inherit}.comment{padding:0;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;width:100%}.remove{position:absolute;right:6px;top:4px;font-size:20px}';
    const card=document.createElement('aside');card.setAttribute('aria-label','Pinned comment');
    const comment=document.createElement('button');comment.className='comment';comment.textContent=annotation.comment;
    const remove=document.createElement('button');remove.className='remove';remove.textContent='×';remove.setAttribute('aria-label','Remove comment');
    for(const [button,action] of [[comment,'edit'],[remove,'remove']])button.addEventListener('click',event=>{event.stopPropagation();if(event.isTrusted){const r=element.getBoundingClientRect();report({id:pin.id,action,point:{x:r.right,y:r.top}});}});
    card.append(comment,remove);shadow.append(style,card);document.documentElement.append(host);entries.push({element,host});
  }
  function update(){for(const {element,host} of entries){const r=element.getBoundingClientRect();host.style.display=element.isConnected&&r.bottom>=0&&r.top<=innerHeight?'block':'none';host.style.left=Math.max(8,Math.min(r.right+12,innerWidth-308))+'px';host.style.top=r.top+'px';}}
  update();document.addEventListener('scroll',update,true);window.addEventListener('resize',update);
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(update):null;observer?.observe(document.documentElement);entries.forEach(({element})=>observer?.observe(element));
  return ()=>{observer?.disconnect();document.removeEventListener('scroll',update,true);window.removeEventListener('resize',update);entries.forEach(({host})=>host.remove());};
})`;

/** The element inspector: outline, grow, pin. `report` gets each pin, and `null` on Escape. */
const ARTIFACT_PICKER_SOURCE = String.raw`(function(report) {
  const cursor = document.createElement('style');
  cursor.setAttribute('data-rally-picker', '');
  cursor.textContent = '* { cursor: ${ARTIFACT_COMMENT_CURSOR} !important; }';
  document.documentElement.append(cursor);
  const outline = document.createElement('div');
  outline.setAttribute('data-rally-picker', '');
  outline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;background:#3b82f614;border-radius:4px;display:none;box-sizing:border-box';
  document.documentElement.append(outline);
  let target = null;
  let leaf = null;
  function show(element) {
    target = element;
    if (!element) { outline.style.display = 'none'; return; }
    const r = element.getBoundingClientRect();
    Object.assign(outline.style, { display:'block', left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px' });
  }
  function move(e) {
    if (!e.isTrusted) return;
    if (!(e.target instanceof Element) || e.target.closest('[data-rally-picker]')) return;
    const found = e.target.closest('p,li,h1,h2,h3,h4,h5,h6,td,th,button,a,input,figure,article,section,div') || e.target;
    if (found !== leaf) { leaf = found; show(e.altKey ? found.parentElement : found); }
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
    report({ point:{x:Math.max(0,e.clientX),y:Math.max(0,e.clientY)}, css:path.join(' > '), box:{x,y,w:Math.max(0,Math.min(1-x,r.width/width)),h:Math.max(0,Math.min(1-y,r.height/height))},visibleText:selected || element.textContent || '',html:trim(element),before:${ARTIFACT_ELEMENT_CONTEXT_SOURCE}(element.previousElementSibling,true,${ANNOTATION_CONTEXT_CHARACTERS}),after:${ARTIFACT_ELEMENT_CONTEXT_SOURCE}(element.nextElementSibling,false,${ANNOTATION_CONTEXT_CHARACTERS}),pagePath:location.pathname+location.search,replace:e.detail>1 });
  }
  function trim(element) { return ${ARTIFACT_ELEMENT_HTML_SOURCE}(element); }
  function double(e) { pin(e); }
  function key(e) {
    if (!e.isTrusted || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { cleanup(); report(null); }
    if (e.key === 'Alt' && target?.parentElement && target.parentElement !== document.documentElement) show(target.parentElement);
    if (e.key === 'ArrowUp' && target?.parentElement) { e.preventDefault(); show(target.parentElement); }
    if (e.key === 'ArrowDown' && target && leaf) {
      e.preventDefault(); let child=leaf;
      while(child.parentElement && child.parentElement!==target && child!==target) child=child.parentElement;
      show(child);
    }
  }
  function scroll() { show(target); }
  function cleanup() {
    cursor.remove(); outline.remove(); document.removeEventListener('mousemove',move,true); document.removeEventListener('click',pin,true); document.removeEventListener('dblclick',double,true); document.removeEventListener('keydown',key,true); document.removeEventListener('scroll',scroll,true);
  }
  document.addEventListener('mousemove',move,true); document.addEventListener('click',pin,true); document.addEventListener('dblclick',double,true); document.addEventListener('keydown',key,true); document.addEventListener('scroll',scroll,true);
  return cleanup;
})`;

/** Highlight only a verified element; resolves whether one was found. */
const ARTIFACT_RESTORE_SOURCE = String.raw`(function(locator,exact){return new Promise(resolve=>{function restore(){let match=null;try{const node=document.querySelector(locator.css);if(node){if(${ARTIFACT_ELEMENT_HTML_SOURCE}(node)===exact && (node.textContent||'').includes(locator.visibleText)){match=node;node.style.outline='2px solid #3b82f6';node.style.backgroundColor='#3b82f61a';node.scrollIntoView({block:'center'});}}}catch{}resolve(!!match);}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',restore,{once:true});else restore();});})`;

/**
 * Installs `globalThis.rallyAnnotations`, the API every host calls:
 *
 * - `pick()` starts the inspector if it is not running and resolves with the
 *   next pin, or `null` once the person presses Escape. Pins made before a
 *   host asks are queued, so a quick second click is not lost.
 * - `stopPicking()` removes the inspector and resolves a waiting `pick()` with
 *   `null`.
 * - `comments(pins)` replaces the cards and resolves with the first edit or
 *   remove click, or `null` when the cards are replaced or there are none.
 * - `restore(locator, exact)` highlights a saved selection, after the document
 *   has parsed, and resolves whether it was found.
 * - `rect(css)` is an element's viewport rectangle, for the desktop's crop.
 *
 * Installed once per document: a second evaluation keeps the first API.
 */
const ARTIFACT_ANNOTATION_API_SOURCE = String.raw`(function(){
  if (globalThis.rallyAnnotations) return globalThis.rallyAnnotations;
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
    comments(pins) {
      return new Promise(resolve => {
        clearComments?.();
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
      void api.comments(Array.isArray(message.pins) ? message.pins : []).then(action => { if (action) post({ type: 'rally-annotation-comment-action', action }); });
    } else if (message.type === 'rally-annotation-restore') {
      void api.restore(message.locator, message.exact).then(resolved => post({ type: 'rally-annotation-restored', resolved }));
    }
  });
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
