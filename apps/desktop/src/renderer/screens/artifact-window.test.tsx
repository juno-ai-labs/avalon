import * as Tooltip from '@radix-ui/react-tooltip';
import {render} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {AnnotationDraftProvider} from '../components/artifact-annotations';
import {ArtifactWindowContent} from './artifact-window';

describe('generated media popouts',()=>{
  it.each([['audio/wav','audio'],['video/mp4','video']])('keeps %s as a media player', (mimeType,tag)=>{
    vi.stubGlobal('URL',class extends URL {static override createObjectURL=()=> 'blob:media-preview';static override revokeObjectURL=()=>{};});
    const {container}=render(<Tooltip.Provider><AnnotationDraftProvider><ArtifactWindowContent files={new Map()} preview={{kind:'generated',resourceId:'00000000-0000-7000-8000-000000000001',version:1,title:'Recording',mimeType:mimeType!,content:new Uint8Array([82,73,70,70])}} /></AnnotationDraftProvider></Tooltip.Provider>);
    expect(container.querySelector(tag!)).toHaveAttribute('controls');
    expect(container.querySelector(tag!)).toHaveAttribute('src','blob:media-preview');
    expect(container.querySelector('.annotation-body')).toBeNull();
  });
});
