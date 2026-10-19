import {fireEvent,render,screen} from '@testing-library/react';
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
