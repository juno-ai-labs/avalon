import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnotationDraftProvider, AnnotationChips, MessageAnnotations, useAnnotationDraft } from './artifact-annotations';
import { sourceSelectionPoint,annotationDomRange } from '../lib/annotation-source';
import { AnnotationSurface } from './annotation-surface';
const resourceId='00000000-0000-7000-8000-0000000000a1';
function Observe():React.JSX.Element {const draft=useAnnotationDraft();return <><AnnotationChips /><output data-testid="pins">{JSON.stringify(draft?.pins.map(p=>p.annotation))}</output></>;}
afterEach(cleanup);
describe('annotation source picker',()=>{
  it('shows website words instead of markup in saved annotations',()=>{
    render(<MessageAnnotations content={{kind:'artifact_annotations',annotations:[{target:{resourceId,version:1,locator:{type:'element',css:'button',box:{x:0,y:0,w:1,h:1},visibleText:'Start free'}},content:{exact:'<button class="cta">Start free</button>',source:'rendered',before:'',after:'',truncated:false},comment:'Make this shorter'}]}} />);
    expect(screen.getByText('Start free')).toBeVisible();
    expect(screen.queryByText('<button class="cta">Start free</button>')).toBeNull();
  });
  it('describes a website selection without text as a selected area',()=>{
    render(<MessageAnnotations content={{kind:'artifact_annotations',annotations:[{target:{resourceId,version:1,locator:{type:'element',css:'img',box:{x:0,y:0,w:1,h:1},visibleText:''}},content:{exact:'<img src="hero.png">',source:'rendered',before:'',after:'',truncated:false},comment:''}]}} />);
    expect(screen.getByText('Selected area')).toBeVisible();
    expect(screen.queryByText('<img src="hero.png">')).toBeNull();
  });

  it('keeps browser HTML comments discoverable without entering pick mode',()=>{
    render(<Tooltip.Provider><AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Pricing.html" mimeType="text/html" text="<h1>Plans</h1>" /></AnnotationDraftProvider></Tooltip.Provider>);
    const button=screen.getByRole('button',{name:'Comment mode'});
    expect(button).toHaveAttribute('aria-disabled','true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed','false');
  });
  it('pins rendered Markdown with exact list markup and keeps a removable commented chip',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={4} name="Pricing.md" mimeType="text/markdown" text={'# Plans\n\n- **Starter**: $12 per seat.\n- Team: $24.\n'} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const item=screen.getByText('Starter').closest('li')!;
    fireEvent.mouseMove(item);fireEvent.click(item,{detail:1,clientX:10,clientY:10});
    fireEvent.change(screen.getByRole('textbox',{name:'Comment on selection'}),{target:{value:'Make this monthly'}});
    const pins=JSON.parse(screen.getByTestId('pins').textContent??'[]');
    expect(pins).toEqual([{target:{resourceId,version:4,locator:{type:'markdown',start:9,end:37,headingPath:['Plans']}},content:{exact:'- **Starter**: $12 per seat.',source:'exact',before:'# Plans\n\n',after:'\n- Team: $24.\n',truncated:false},comment:'Make this monthly'}]);
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Enter'});
    expect(screen.queryByRole('textbox',{name:'Comment on selection'})).toBeNull();
    expect(screen.getByRole('button',{name:'Remove pin 1'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Remove pin 1'}));
    expect(screen.getByTestId('pins')).toHaveTextContent('[]');
  });
  it('grows a list item to its list and then its section without consuming scroll input',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Pricing.md" mimeType="text/markdown" text={'# Plans\n\n- One\n- Two\n\n## FAQ\n\nLater.'} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const item=screen.getByText('One').closest('li')!;
    fireEvent.mouseMove(item);fireEvent.keyDown(item,{key:'ArrowUp'});fireEvent.click(item,{detail:1});
    expect(JSON.parse(screen.getByTestId('pins').textContent??'[]')[0].content.exact).toBe('- One\n- Two');
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Enter'});
    fireEvent.keyDown(item,{key:'ArrowUp'});fireEvent.click(item,{detail:1});
    expect(JSON.parse(screen.getByTestId('pins').textContent??'[]')[1].content.exact).toBe('# Plans\n\n- One\n- Two\n\n## FAQ\n\nLater.');
  });
  it('maps highlighted code tokens to exact source offsets without including its fence',()=>{
    const text='# Example\n\n```js\nconst price = 12;\n```\n';
    const {container}=render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Code.md" mimeType="text/markdown" text={text} /><Observe /></AnnotationDraftProvider>);
    const code=container.querySelector('pre code')!;
    const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
    let node=walker.nextNode();while(node && !node.textContent?.includes('price'))node=walker.nextNode();
    expect(node).not.toBeNull();
    const start=sourceSelectionPoint(node!,node!.textContent!.indexOf('price'),text);const end=sourceSelectionPoint(node!,node!.textContent!.indexOf('price')+5,text);
    expect(text.slice(start!,end!)).toBe('price');
    expect(annotationDomRange(container,text,start!,end!)?.toString()).toBe('price');
  });
  it('maps a code word to the body rather than the same word in its fence language',()=>{
    const text='```js\njs\n```';
    const {container}=render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Code.md" mimeType="text/markdown" text={text} /><Observe /></AnnotationDraftProvider>);
    const code=container.querySelector('pre code')!;const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);const node=walker.nextNode()!;
    expect(sourceSelectionPoint(node,0,text)).toBe(6);
    expect(sourceSelectionPoint(node,2,text)).toBe(8);
  });
  it('pins the hovered plain text paragraph with its original whitespace',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Notes.txt" mimeType="text/plain" text={'First paragraph.\n\nSecond  paragraph.\nContinued.'} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const paragraph=screen.getByText(/Second paragraph/u);fireEvent.mouseMove(paragraph);fireEvent.click(paragraph,{detail:1});
    expect(JSON.parse(screen.getByTestId('pins').textContent??'[]')[0].content.exact).toBe('Second  paragraph.\nContinued.');
  });

});
