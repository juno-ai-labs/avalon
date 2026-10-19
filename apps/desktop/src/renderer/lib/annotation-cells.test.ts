import { describe, expect, it } from 'vitest';
import { annotationCellRange, annotationSheets, columnName, resolveAnnotationCells } from './annotation-cells';
describe('annotation cell ranges', () => {
  it('reads sparse workbook cells and includes the header with a selected rectangle', () => {
    const sheet = annotationSheets('# Sheet: Pipeline\n\nA1: Name\nB1: Amount\nA2: Acme\nB2: 12\nA3: Beta\nB3: 24')[0]!;
    expect(annotationCellRange(sheet,[1,0],[2,1])).toEqual({range:'A2:B3',table:'| Name | Amount |\n| --- | --- |\n| Acme | 12 |\n| Beta | 24 |'});
  });
  it('renders quoted CSV bytes as cells and quotes a range with its headers',()=>{
    const sheet=annotationSheets('Plan,Note\r\nTeam,"Includes, Sidekicks"\r\n')[0]!;
    expect(annotationCellRange(sheet,[1,0],[1,1])).toEqual({range:'A2:B2',table:'| Plan | Note |\n| --- | --- |\n| Team | Includes, Sidekicks |'});
  });
  it('quotes a converted CSV column with its own header exactly once', () => {
    const sheet = annotationSheets('| Name | Amount |\n| --- | --- |\n| Acme | 12 |')[0]!;
    expect(annotationCellRange(sheet,[0,1],[1,1])).toEqual({range:'B1:B2',table:'| Amount |\n| --- |\n| 12 |'});
    expect(columnName(26)).toBe('AA');
  });
  it('restores a saved range only when its historical table still matches',()=>{
    const text='Plan,Price\nStarter,12\nTeam,24\n';
    expect(resolveAnnotationCells(text,'Sheet1','B2:B3','| Price |\n| --- |\n| 12 |\n| 24 |')).toEqual({index:0,start:[1,1],end:[2,1]});
    expect(resolveAnnotationCells(text,'Sheet1','B2:B3','| Price |\n| --- |\n| 99 |')).toBeNull();
  });

});
