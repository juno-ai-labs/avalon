import { useEffect, useMemo, useRef, useState } from 'react';
import { annotationSheets, annotationCellRange, annotationRange, columnName, resolveAnnotationCells } from '../lib/annotation-cells';
import type { AnnotationLocator, Annotation } from '@rally/contracts';

type Cell = [number,number];
type CellRange = {start:Cell;end:Cell};
const ROW_HEIGHT = 30;
const COLUMN_WIDTH = 160;
const inRange = (row:number,column:number,range:CellRange):boolean => row>=Math.min(range.start[0],range.end[0]) && row<=Math.max(range.start[0],range.end[0]) && column>=Math.min(range.start[1],range.end[1]) && column<=Math.max(range.start[1],range.end[1]);

export function AnnotationSheet({text,picking,onPin,saved,pins=[]}: {text:string;picking:boolean;saved?:Annotation|undefined;pins?:readonly Annotation[];onPin:(locator:AnnotationLocator,exact:string)=>void}):React.JSX.Element {
  const sheets=useMemo(()=>annotationSheets(text),[text]);
  const root=useRef<HTMLDivElement>(null);
  const scroll=useRef<HTMLDivElement>(null);
  const [index,setIndex]=useState(0);
  const [viewport,setViewport]=useState({top:0,left:0,height:360,width:800});
  const [hover,setHover]=useState<CellRange|null>(null);
  const [drag,setDrag]=useState<CellRange|null>(null);
  const start=useRef<Cell|null>(null);
  const sheet=sheets[index]??{name:'Sheet1',cells:[]};
  const width=Object.values(sheet.cells).reduce((max,row)=>Math.max(max,row.length),0);
  const restored=useMemo(()=>saved?.target.locator.type==='cells'?resolveAnnotationCells(text,saved.target.locator.sheet,saved.target.locator.range,saved.content.exact):null,[saved,text]);
  const ranges=(saved?[saved]:pins).flatMap((pin)=>{
    const locator=pin.target.locator;
    if(locator.type!=='cells'||locator.sheet!==sheet.name)return [];
    const range=annotationRange(locator.range);
    return range?[range]:[];
  });
  useEffect(()=>{
    if(!restored)return;
    setIndex(restored.index);
    if(scroll.current){scroll.current.scrollTop=restored.start[0]*ROW_HEIGHT;scroll.current.scrollLeft=restored.start[1]*COLUMN_WIDTH;}
  },[restored,index]);
  useEffect(()=>{
    const clear=():void=>{start.current=null;setDrag(null);};
    window.addEventListener('pointerup',clear);window.addEventListener('blur',clear);
    return()=>{window.removeEventListener('pointerup',clear);window.removeEventListener('blur',clear);};
  },[]);
  useEffect(()=>{
    const element=scroll.current;if(!element)return;
    const measure=():void=>setViewport({top:element.scrollTop,left:element.scrollLeft,height:element.clientHeight||360,width:element.clientWidth||800});
    measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();
  },[]);
  const pin=(a:Cell,b:Cell):void=>{
    if(!picking||!sheet.cells.length||!width)return;
    const result=annotationCellRange(sheet,a,b);
    onPin({type:'cells',sheet:sheet.name,range:result.range},result.table);
  };
  // Render only the viewport while keeping original sparse coordinates.
  const firstRow=Math.max(0,Math.floor(viewport.top/ROW_HEIGHT)-2);
  const lastRow=Math.min(sheet.cells.length,Math.ceil((viewport.top+viewport.height)/ROW_HEIGHT)+2);
  const firstColumn=Math.max(0,Math.floor(viewport.left/COLUMN_WIDTH)-1);
  const lastColumn=Math.min(width,Math.ceil((viewport.left+viewport.width)/COLUMN_WIDTH)+1);
  const columns=Array.from({length:lastColumn-firstColumn},(_,i)=>firstColumn+i);
  return <div className="annotation-sheet" ref={root}>
    <div className="annotation-sheet-tabs">{sheets.map((item,i)=><button aria-pressed={i===index} key={item.name} type="button" onClick={()=>{setIndex(i);setHover(null);setDrag(null);start.current=null;if(scroll.current){scroll.current.scrollTop=0;scroll.current.scrollLeft=0;}setViewport((value)=>({...value,top:0,left:0}));}}>{item.name}</button>)}<button type="button" disabled={!picking} onClick={()=>pin([0,0],[sheet.cells.length-1,width-1])}>Pin sheet</button></div>
    <div className="annotation-sheet-scroll" ref={scroll} onScroll={(e)=>setViewport({top:e.currentTarget.scrollTop,left:e.currentTarget.scrollLeft,height:e.currentTarget.clientHeight,width:e.currentTarget.clientWidth})} onPointerLeave={()=>setHover(null)}>
      <table style={{width:width*COLUMN_WIDTH+46,tableLayout:'fixed'}}><thead><tr style={{height:ROW_HEIGHT}}><th style={{width:46}}/>{firstColumn>0&&<th style={{width:firstColumn*COLUMN_WIDTH}}/>}{columns.map((column)=><th style={{width:COLUMN_WIDTH}} key={column} onPointerEnter={()=>setHover({start:[0,column],end:[sheet.cells.length-1,column]})}><button disabled={!picking} type="button" onClick={()=>pin([0,column],[sheet.cells.length-1,column])}>{columnName(column)}</button></th>)}{lastColumn<width&&<th style={{width:(width-lastColumn)*COLUMN_WIDTH}}/>}</tr></thead>
      <tbody>{firstRow>0&&<tr aria-hidden="true" style={{height:firstRow*ROW_HEIGHT}}><td colSpan={columns.length+3}/></tr>}{Array.from({length:lastRow-firstRow},(_,i)=>firstRow+i).map((row)=><tr key={row} style={{height:ROW_HEIGHT}}><th onPointerEnter={()=>setHover({start:[row,0],end:[row,width-1]})}><button disabled={!picking} type="button" onClick={()=>pin([row,0],[row,width-1])}>{row+1}</button></th>{firstColumn>0&&<td/>}{columns.map((column)=><td key={column} className={ranges.some((range)=>inRange(row,column,range))?'annotation-highlight':picking&&(drag||hover)&&inRange(row,column,(drag??hover)!)?'annotation-cell-hover':undefined}
        onPointerDown={(e)=>{if(picking){e.preventDefault();start.current=[row,column];setDrag({start:[row,column],end:[row,column]});}}}
        onPointerEnter={()=>{setHover({start:[row,column],end:[row,column]});if(picking&&start.current)setDrag({start:start.current,end:[row,column]});}}
        onPointerUp={()=>{if(start.current){pin(start.current,[row,column]);start.current=null;setDrag(null);}}}><button type="button" disabled={!picking} onClick={(e)=>{if(e.detail===0)pin([row,column],[row,column]);}}>{sheet.cells[row]?.[column]??''}</button></td>)}{lastColumn<width&&<td/>}</tr>)}{lastRow<sheet.cells.length&&<tr aria-hidden="true" style={{height:(sheet.cells.length-lastRow)*ROW_HEIGHT}}><td colSpan={columns.length+3}/></tr>}</tbody></table>
    </div>
  </div>;
}
