const ARTIFACT_ELEMENT_HTML_SOURCE = String.raw`(function(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('script,style,[data-rally-picker]').forEach(n=>n.remove());
    for (const n of [clone,...clone.querySelectorAll('*')]) for (const a of [...n.attributes]) {
      if (a.name.startsWith('on') || a.name === 'd' || a.value.trim().startsWith('data:')) n.removeAttribute(a.name);
    }
    return clone.outerHTML.replace(/\s+/gu,' ').trim();
  })`;
/** Tabler pointer-collaboration, MIT. Hotspot matches the pointer tip. */
export const ARTIFACT_COMMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" stroke="#2563eb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.943 13.013l5.016 -1.957c1.445 -.563 1.367 -2.633 -.116 -3.087l-12.727 -3.895c-1.253 -.384 -2.426 .79 -2.042 2.042l3.895 12.727c.454 1.483 2.524 1.56 3.087 .116l1.957 -5.017c.166 -.426 .503 -.763 .93 -.929"/><path d="M20 15l-3.151 1.064a1.25 1.25 0 0 0 -.785 .785l-1.064 3.151" fill="none"/></svg>')}") 4 4, crosshair`;
/** Trusted comment UI, shared by opaque HTML previews and native isolated worlds. */
export const ARTIFACT_COMMENTS_SOURCE = String.raw`(function(pins,report) {
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
  const observer=new ResizeObserver(update);observer.observe(document.documentElement);entries.forEach(({element})=>observer.observe(element));
  return ()=>{observer.disconnect();document.removeEventListener('scroll',update,true);window.removeEventListener('resize',update);entries.forEach(({host})=>host.remove());};
})`;

/** One self-contained picker for opaque HTML and isolated Electron worlds. */
export const ARTIFACT_PICKER_SOURCE = String.raw`(function(report) {
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
    report({ point:{x:Math.max(0,e.clientX),y:Math.max(0,e.clientY)}, css:path.join(' > '), box:{x,y,w:Math.max(0,Math.min(1-x,r.width/width)),h:Math.max(0,Math.min(1-y,r.height/height))},visibleText:selected || element.textContent || '',html:trim(element),pagePath:location.pathname+location.search,replace:e.detail>1 });
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
export function artifactPickerScript(): string {
  return ARTIFACT_PICKER_SOURCE + "((pin)=>parent.postMessage({type:'rally-artifact-pin',pin},'*'))";
}

/** Restore only a verified element; callable without evaluating page-provided code. */
export const ARTIFACT_RESTORE_SOURCE = String.raw`(function(locator,exact){function restore(){let match=null;try{const node=document.querySelector(locator.css);if(node){if(${ARTIFACT_ELEMENT_HTML_SOURCE}(node)===exact && (node.textContent||'').includes(locator.visibleText)){match=node;node.style.outline='2px solid #3b82f6';node.style.backgroundColor='#3b82f61a';node.scrollIntoView({block:'center'});}}}catch{}parent.postMessage({type:'rally-annotation-restored',resolved:!!match},'*');}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',restore,{once:true});else restore();})`;
/** Bundled trusted script: srcdoc inherits the app CSP, so an inline nonce alone is insufficient. */
export function artifactFrameScript(): string {
  return `(function(){let clearComments;window.addEventListener('message',event=>{if(event.source!==parent || event.data?.type!=='rally-annotation-comments')return;clearComments?.();clearComments=${ARTIFACT_COMMENTS_SOURCE}(event.data.pins,action=>parent.postMessage({type:'rally-annotation-comment-action',action},'*'));});const data=document.currentScript.getAttribute('data-annotation-saved');if(data){const saved=JSON.parse(data);${ARTIFACT_RESTORE_SOURCE}(saved.locator,saved.exact);}else if(document.currentScript.getAttribute('data-annotation-picking')!=='false'){${artifactPickerScript()};}})()`;
}
