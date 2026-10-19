import { useEffect, useRef, useState } from 'react';
import { annotationSheets, annotationCellRange, columnName, resolveAnnotationCells } from '../lib/annotation-cells';
import type { AnnotationLocator, Annotation } from '@rally/contracts';
export function AnnotationSheet({ text, picking, onPin, saved }: { text: string; picking: boolean; saved?: Annotation | undefined; onPin: (locator: AnnotationLocator, exact: string) => void }): React.JSX.Element {
  const sheets = annotationSheets(text);
  const root = useRef<HTMLDivElement>(null);
  const restored = saved?.target.locator.type === 'cells' ? resolveAnnotationCells(text,saved.target.locator.sheet,saved.target.locator.range,saved.content.exact) : null;
  const [index, setIndex] = useState(0);
  const sheet = sheets[index] ?? { name: 'Sheet1', cells: [] };
  const width = Math.max(0, ...sheet.cells.map((r) => r.length));
  const [hoverCell,setHoverCell]=useState<{start:[number,number];end:[number,number]}|null>(null);
  const start = useRef<[number,number] | null>(null);
  const [selection, setSelection] = useState<{ start: [number,number]; end: [number,number] } | null>(null);
  useEffect(() => { if (restored) { setIndex(restored.index); setSelection({start:restored.start,end:restored.end}); } },[saved,text]);
  useEffect(() => { if (saved && selection) root.current?.querySelector('.annotation-highlight')?.scrollIntoView({block:'center',inline:'center'}); },[index,saved,selection]);
  const pin = (a: [number,number], b: [number,number]): void => {
    if (!picking || !sheet.cells.length || !width) return;
    setSelection({ start:a, end:b });
    const result = annotationCellRange(sheet,a,b);
    onPin({ type:'cells',sheet:sheet.name,range:result.range },result.table);
  };
  return <div className="annotation-sheet" ref={root}><div className="annotation-sheet-tabs">{sheets.map((s,i) => <button aria-pressed={i===index} key={i} type="button" onClick={() => setIndex(i)}>{s.name}</button>)}<button type="button" disabled={!picking} onClick={() => pin([0,0],[sheet.cells.length-1,width-1])}>Pin sheet</button></div>
    <div className="annotation-sheet-scroll" onPointerLeave={()=>setHoverCell(null)}><table><thead><tr><th />{Array.from({length:width},(_,col) => <th key={col} onPointerEnter={()=>setHoverCell({start:[0,col],end:[sheet.cells.length-1,col]})}><button disabled={!picking} type="button" onClick={() => pin([0,col],[sheet.cells.length-1,col])}>{columnName(col)}</button></th>)}</tr></thead>
    <tbody>{sheet.cells.map((row,r) => <tr key={r}><th onPointerEnter={()=>setHoverCell({start:[r,0],end:[r,width-1]})}><button disabled={!picking} type="button" onClick={() => pin([r,0],[r,width-1])}>{r+1}</button></th>{Array.from({length:width},(_,c) => <td key={c} className={selection && r>=Math.min(selection.start[0],selection.end[0]) && r<=Math.max(selection.start[0],selection.end[0]) && c>=Math.min(selection.start[1],selection.end[1]) && c<=Math.max(selection.start[1],selection.end[1]) ? 'annotation-highlight' : picking&&hoverCell&&r>=Math.min(hoverCell.start[0],hoverCell.end[0])&&r<=Math.max(hoverCell.start[0],hoverCell.end[0])&&c>=Math.min(hoverCell.start[1],hoverCell.end[1])&&c<=Math.max(hoverCell.start[1],hoverCell.end[1])?'annotation-cell-hover':undefined}
      onPointerDown={(e) => { if (picking) { e.preventDefault(); start.current=[r,c]; } }} onPointerEnter={() => { setHoverCell({start:[r,c],end:[r,c]}); if (picking && start.current) setSelection({start:start.current,end:[r,c]}); }} onPointerUp={() => { if(start.current) { pin(start.current,[r,c]); start.current=null; } }}><button type="button" disabled={!picking} onClick={(e)=>{if(e.detail===0)pin([r,c],[r,c]);}}>{row[c] ?? ''}</button></td>)}</tr>)}</tbody></table></div></div>;
}
