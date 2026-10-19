import {fireEvent,render,screen} from '@testing-library/react';
import {describe,expect,it} from 'vitest';
import type {Annotation} from '@rally/contracts';
import {AnnotationSheet} from './annotation-sheet';
const text='# Sheet: First\nA1: Name\nB1: Price\nA2: One\nB2: 12\n# Sheet: Second\nA1: Other\nB1: Cost\nA2: Two\nB2: 24';
const pin=(range:string):Annotation=>({target:{resourceId:'00000000-0000-7000-8000-000000000001',version:1,locator:{type:'cells',sheet:'First',range}},content:{exact:'',source:'converted',before:'',after:'',truncated:false},comment:''});
describe('sheet pin highlights',()=>{
  it('tracks all pins on their own sheet and removes deleted highlights',()=>{
    const {rerender}=render(<AnnotationSheet text={text} picking onPin={()=>{}} pins={[pin('A2:A2'),pin('B2:B2')]}/>);
    expect(screen.getByText('One').closest('td')).toHaveClass('annotation-highlight');
    expect(screen.getByText('12').closest('td')).toHaveClass('annotation-highlight');
    rerender(<AnnotationSheet text={text} picking onPin={()=>{}} pins={[pin('B2:B2')]}/>);
    expect(screen.getByText('One').closest('td')).not.toHaveClass('annotation-highlight');
    fireEvent.click(screen.getByRole('button',{name:'Second'}));
    expect(screen.getByText('Two').closest('td')).not.toHaveClass('annotation-highlight');
  });
  it('renders a viewport rather than expanding distant sparse cells',()=>{
    const {container}=render(<AnnotationSheet text={'# Sheet: Sparse\nA1: Heading\nZ100000: Distant'} picking={false} onPin={()=>{}}/>);
    expect(screen.getByText('Heading')).toBeVisible();
    expect(screen.queryByText('Distant')).toBeNull();
    expect(container.querySelectorAll('td').length).toBeLessThan(300);
  });
});
