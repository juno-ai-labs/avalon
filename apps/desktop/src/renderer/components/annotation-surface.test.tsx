import * as Tooltip from '@radix-ui/react-tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnotationDraftProvider, AnnotationChips, MessageAnnotations, useAnnotationDraft } from './artifact-annotations';
import { sourceSelectionPoint,annotationDomRange } from '../lib/annotation-source';
import { AnnotationSurface } from './annotation-surface';
const resourceId='00000000-0000-7000-8000-0000000000a1';
function Observe():React.JSX.Element {const draft=useAnnotationDraft();return <><AnnotationChips /><button onClick={()=>draft?.clear(draft.pins.map((pin)=>pin.id))}>Accept message</button><output data-testid="pins">{JSON.stringify(draft?.selections.map(p=>p.annotation))}</output></>;}
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
    expect(screen.queryByLabelText('Annotation pins')).toBeNull();
    const editor=screen.getByRole('textbox',{name:'Comment on selection'});
    expect(screen.getByRole('button',{name:'Send comment'})).toBeDisabled();
    fireEvent.keyDown(editor,{key:'Enter'});
    expect(editor).toBeVisible();
    fireEvent.change(editor,{target:{value:'Make this monthly'}});
    expect(screen.queryByLabelText('Annotation pins')).toBeNull();
    expect(editor.closest('[role=dialog]')?.querySelector('q')).toBeNull();
    const pins=JSON.parse(screen.getByTestId('pins').textContent??'[]');
    expect(pins).toEqual([{target:{resourceId,version:4,locator:{type:'markdown',start:9,end:37,headingPath:['Plans']}},content:{exact:'- **Starter**: $12 per seat.',source:'exact',before:'# Plans\n\n',after:'\n- Team: $24.\n',truncated:false},comment:'Make this monthly'}]);
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Enter'});
    expect(screen.queryByRole('textbox',{name:'Comment on selection'})).toBeNull();
    expect(screen.getByRole('button',{name:'Remove pin 1'})).toBeVisible();
    expect(screen.getByLabelText('Pinned comment')).toHaveTextContent('Make this monthly');
    fireEvent.click(screen.getByRole('button',{name:'Remove pin 1'}));
    expect(screen.getByTestId('pins')).toHaveTextContent('[]');
  });
  it('adds a selection to the input only when Send confirms a nonempty comment',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Note.txt" mimeType="text/plain" text="Selected words" /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const text=screen.getByText('Selected words');
    fireEvent.mouseMove(text);fireEvent.click(text);
    const editor=screen.getByRole('textbox',{name:'Comment on selection'});
    fireEvent.change(editor,{target:{value:'   '}});
    expect(screen.getByRole('button',{name:'Send comment'})).toBeDisabled();
    fireEvent.change(editor,{target:{value:'Shorten this'}});
    fireEvent.keyDown(editor,{key:'Enter',keyCode:229});
    expect(screen.queryByLabelText('Annotation pins')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Send comment'}));
    expect(screen.getByLabelText('Annotation pins')).toHaveTextContent('Selected words');
    expect(screen.getByLabelText('Annotation pins')).toHaveTextContent('Shorten this');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps comments beside each selection after confirmation and leaving comment mode',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Notes.txt" mimeType="text/plain" text={'First paragraph.\n\nSecond paragraph.'} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    for (const [text,comment] of [['First paragraph.','Shorten the first'],['Second paragraph.','Expand the second']]) {
      const paragraph=screen.getByText(text!);
      fireEvent.mouseMove(paragraph);fireEvent.click(paragraph);
      fireEvent.change(screen.getByRole('textbox',{name:'Comment on selection'}),{target:{value:comment}});
      fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Enter'});
    }
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    expect(screen.getAllByLabelText('Pinned comment')).toHaveLength(2);
    expect(screen.getAllByLabelText('Pinned comment')[0]).toHaveTextContent('Shorten the first');
    expect(screen.getAllByLabelText('Pinned comment')[1]).toHaveTextContent('Expand the second');
    fireEvent.click(screen.getAllByRole('button',{name:'Remove comment'})[0]!);
    expect(screen.getAllByLabelText('Pinned comment')).toHaveLength(1);
    expect(screen.getByLabelText('Pinned comment')).toHaveTextContent('Expand the second');
  });
  it('discards an unfinished selection on Escape and preserves a confirmed comment when its editor closes',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Note.txt" mimeType="text/plain" text="Selected words" /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const paragraph=screen.getByText('Selected words');
    fireEvent.mouseMove(paragraph);fireEvent.click(paragraph);
    fireEvent.change(screen.getByRole('textbox',{name:'Comment on selection'}),{target:{value:'Unfinished'}});
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Escape'});
    expect(screen.getByTestId('pins')).toHaveTextContent('[]');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    fireEvent.mouseMove(paragraph);fireEvent.click(paragraph);
    fireEvent.change(screen.getByRole('textbox',{name:'Comment on selection'}),{target:{value:'Keep this'}});
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Enter'});
    fireEvent.click(screen.getByRole('button',{name:'Keep this'}));
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Escape'});
    expect(screen.getByLabelText('Pinned comment')).toHaveTextContent('Keep this');
    expect(screen.getByLabelText('Annotation pins')).toHaveTextContent('Keep this');
  });
  it('replaces an abandoned selection and clears unfinished highlights when a message is accepted',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Notes.txt" mimeType="text/plain" text={'First paragraph.\n\nSecond paragraph.'} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const first=screen.getByText('First paragraph.');
    fireEvent.mouseMove(first);fireEvent.click(first);
    fireEvent.change(screen.getByRole('textbox',{name:'Comment on selection'}),{target:{value:'Abandoned'}});
    const second=screen.getByText('Second paragraph.');
    fireEvent.mouseMove(second);fireEvent.click(second);
    const selections=JSON.parse(screen.getByTestId('pins').textContent??'[]');
    expect(selections).toHaveLength(1);
    expect(selections[0].content.exact).toBe('Second paragraph.');
    expect(screen.getByRole('textbox',{name:'Comment on selection'})).toHaveValue('');
    fireEvent.click(screen.getByRole('button',{name:'Accept message'}));
    expect(screen.getByTestId('pins')).toHaveTextContent('[]');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('grows a list item to its list and then its section without consuming scroll input',()=>{
    render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Pricing.md" mimeType="text/markdown" text={'# Plans\n\n- One\n- Two\n\n## FAQ\n\nLater.'} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
    const item=screen.getByText('One').closest('li')!;
    fireEvent.mouseMove(item);fireEvent.keyDown(item,{key:'ArrowUp'});fireEvent.click(item,{detail:1});
    expect(JSON.parse(screen.getByTestId('pins').textContent??'[]')[0].content.exact).toBe('- One\n- Two');
    fireEvent.change(screen.getByRole('textbox',{name:'Comment on selection'}),{target:{value:'Update this list'}});
    fireEvent.keyDown(screen.getByRole('textbox',{name:'Comment on selection'}),{key:'Enter'});
    fireEvent.keyDown(item,{key:'ArrowUp'});fireEvent.click(item,{detail:1});
    expect(JSON.parse(screen.getByTestId('pins').textContent??'[]')[1].content.exact).toBe('# Plans\n\n- One\n- Two\n\n## FAQ\n\nLater.');
  });
  it('maps highlighted code tokens to exact source offsets without including its fence',()=>{
    const text='# Example\n\n```js\nconst price = 12;\n```\n';
    const {container}=render(<AnnotationDraftProvider><AnnotationSurface resourceId={resourceId} version={1} name="Code.md" mimeType="text/markdown" text={text} /><Observe /></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
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
    fireEvent.click(screen.getByRole('button',{name:'Comment mode'}));
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

  it('reveals the saved quote when its original image cannot load',()=>{
    const saved={target:{resourceId,version:1,locator:{type:'region' as const,x:0,y:0,w:1,h:1}},content:{exact:'Region of Layout.png',source:'exact' as const,before:'',after:'',truncated:false},comment:'Use more contrast'};
    render(<AnnotationSurface resourceId={resourceId} version={1} name="Layout.png" mimeType="image/png" src="broken-original.png" saved={saved}/>);
    fireEvent.error(screen.getByRole('img',{name:'Layout.png'}));
    expect(screen.getByText('Region of Layout.png')).toBeVisible();
    expect(screen.getByText('Use more contrast')).toBeVisible();
  });

});
