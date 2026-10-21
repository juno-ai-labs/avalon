import {act,fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import {AnnotationChips,AnnotationDraftProvider,useAnnotationDraft} from './artifact-annotations';
function Fixture():React.JSX.Element {
  const draft=useAnnotationDraft();
  return <><button onClick={()=>draft?.add({target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'element',css:'button',box:{x:0,y:0,w:1,h:1},visibleText:'Start free'}},content:{exact:'<button>Start free</button>',source:'rendered',before:'',after:'',truncated:false},comment:''},'Website',()=>false)}>Receive popout pin</button><AnnotationChips/></>;
}
describe('draft annotation editing',()=>{
  it('edits a transferred pin after its original preview has closed',()=>{
    render(<AnnotationDraftProvider><Fixture/></AnnotationDraftProvider>);
    fireEvent.click(screen.getByRole('button',{name:'Receive popout pin'}));
    fireEvent.click(screen.getByRole('button',{name:/Start free/u}));
    const editor=screen.getByRole('textbox',{name:'Comment on pin 1'});
    fireEvent.change(editor,{target:{value:'Use Try Rally'}});
    fireEvent.keyDown(editor,{key:'Enter',keyCode:229});
    expect(editor).toBeVisible();
    fireEvent.keyDown(editor,{key:'Enter'});
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Use Try Rally')).toBeVisible();
  });
});

it('manual reattachment preserves the authored comment and cancellation preserves the original',()=>{
  let draft:ReturnType<typeof useAnnotationDraft>;
  function Observe():React.JSX.Element|null {draft=useAnnotationDraft();return null;}
  render(<AnnotationDraftProvider><Observe/><AnnotationChips/></AnnotationDraftProvider>);
  const annotation={target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'text' as const,start:0,end:3,lines:[1,1] as [number,number]}},content:{exact:'Old',source:'exact' as const,before:'',after:'',truncated:false},comment:'Please clarify'};
  act(()=>{draft!.add(annotation,'Notes',()=>false);});
  const original=draft!.pins[0]!;
  act(()=>{draft!.repair(original);});
  let candidate='';
  act(()=>{candidate=draft!.add({...annotation,target:{...annotation.target,version:2},content:{...annotation.content,exact:'New'},comment:''},'Notes',()=>false,undefined,true);});
  expect(draft!.selections.find((pin)=>pin.id===candidate)?.annotation.comment).toBe('Please clarify');
  act(()=>{draft!.cancelRepair();});
  expect(draft!.pins[0]?.annotation.content.exact).toBe('Old');
  act(()=>{draft!.repair(original);});
  act(()=>{candidate=draft!.add({...annotation,target:{...annotation.target,version:2},content:{...annotation.content,exact:'New'},comment:''},'Notes',()=>false,undefined,true);});
  act(()=>{draft!.confirm(candidate);});
  expect(draft!.pins).toHaveLength(1);
  expect(draft!.pins[0]).toMatchObject({id:original.id,annotation:{comment:'Please clarify',target:{version:2},content:{exact:'New'}},original:{target:{version:1},content:{exact:'Old'}}});
});
