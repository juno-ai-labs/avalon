export interface AnnotationSheet { name: string; cells: string[][] }
export function columnName(index: number): string {
  let value = index + 1; let result = '';
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
export function columnIndex(name: string): number { return [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1; }
export function annotationSheets(text: string): AnnotationSheet[] {
  if (/^# Sheet: /mu.test(text)) {
    return [...text.matchAll(/^# Sheet: (.+)\n([\s\S]*?)(?=^# Sheet: |$(?![\s\S]))/gmu)].map((match) => {
      const cells: string[][] = [];
      for (const cell of (match[2] ?? '').matchAll(/^([A-Z]+)([1-9]\d*): (.*)$/gmu)) {
        const row = Number(cell[2]) - 1; const col = columnIndex(cell[1] ?? 'A');
        cells[row] ??= []; cells[row]![col] = cell[3] ?? '';
      }
      return { name: match[1] ?? 'Sheet1', cells: Array.from({ length: cells.length }, (_, i) => cells[i] ?? []) };
    });
  }
  if (!/^\s*\|/mu.test(text)) {
    const delimiter = text.split('\n',1)[0]?.includes('\t') ? '\t' : ',';
    const rows:string[][]=[];let row:string[]=[];let value='';let quoted=false;
    for(let index=0;index<text.length;index+=1){
      const character=text[index];
      if(character==='"'){
        if(quoted&&text[index+1]==='"'){value+='"';index+=1;}
        else quoted=!quoted;
      }else if(!quoted&&character===delimiter){row.push(value);value='';}
      else if(!quoted&&(character==='\n'||character==='\r')){if(character==='\r'&&text[index+1]==='\n')index+=1;row.push(value);rows.push(row);row=[];value='';}
      else value+=character;
    }
    if(value||row.length){row.push(value);rows.push(row);}
    return [{name:'Sheet1',cells:rows}];
  }
  const rows = text.split('\n').filter((line) => /^\s*\|/u.test(line) && !/^\s*\|[\s:|-]+\|\s*$/u.test(line)).map((line) => line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).map((v) => v.trim().replaceAll('\\|','|')));
  return [{ name: 'Sheet1', cells: rows }];
}
export function annotationCellRange(sheet: AnnotationSheet, start: [number, number], end: [number, number]): { range: string; table: string } {
  const firstRow = Math.min(start[0], end[0]); const lastRow = Math.max(start[0], end[0]);
  const firstCol = Math.min(start[1], end[1]); const lastCol = Math.max(start[1], end[1]);
  const columns = Array.from({ length: lastCol - firstCol + 1 }, (_, i) => firstCol + i);
  const line = (row: number): string => `| ${columns.map((c) => (sheet.cells[row]?.[c] ?? '').replaceAll('|','\\|').replaceAll('\n',' ')).join(' | ')} |`;
  const rows = Array.from({ length: lastRow - firstRow + 1 }, (_, i) => firstRow + i).filter((r) => r !== 0);
  return { range: `${columnName(firstCol)}${firstRow + 1}:${columnName(lastCol)}${lastRow + 1}`, table: [line(0), `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map(line)].join('\n') };
}

/** Verify both the saved coordinates and quote before revealing a historical range. */
export function resolveAnnotationCells(text: string, sheetName: string, range: string, exact: string): {index:number; start:[number,number];end:[number,number]} | null {
  const sheets = annotationSheets(text);
  const index = sheets.findIndex((sheet) => sheet.name === sheetName);
  const match = /^([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/u.exec(range);
  const sheet = sheets[index];
  if (!sheet || !match) return null;
  const start:[number,number] = [Number(match[2])-1,columnIndex(match[1]!)];
  const end:[number,number] = [Number(match[4])-1,columnIndex(match[3]!)];
  if (end[0] >= sheet.cells.length || annotationCellRange(sheet,start,end).table !== exact) return null;
  return {index,start,end};
}
