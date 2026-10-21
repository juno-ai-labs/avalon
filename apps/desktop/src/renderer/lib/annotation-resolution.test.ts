import { describe, expect, it } from 'vitest';
import type { Annotation } from '@rally/contracts';
import { resolveAnnotation, resolveAnnotationText } from './annotation-resolution';

const annotation: Annotation = {
  target: { resourceId: '00000000-0000-7000-8000-000000000001', version: 1, locator: { type: 'text', start: 7, end: 12, lines: [1, 1] } },
  content: { exact: 'world', before: 'Hello, ', after: '!', source: 'exact', truncated: false }, comment: 'Make this friendlier',
};
describe('annotation revision resolution', () => {
  it('moves an exact selection and rebuilds its source location', () => {
    expect(resolveAnnotationText(annotation, 'Intro\nHello, world!', 2)).toMatchObject({ state: 'ready', annotation: {
      target: { version: 2, locator: { start: 13, end: 18, lines: [2, 2] } }, content: { exact: 'world', before: 'Intro\nHello, ', after: '!' }, comment: 'Make this friendlier',
    } });
  });
  it('uses context to distinguish repeated quotes', () => {
    expect(resolveAnnotationText(annotation, 'world first. Hello, world!', 2)).toMatchObject({ state: 'ready', annotation: { target: { locator: { start: 20 } } } });
  });
  it('rejects ambiguous repeated quotes even if the old offset still matches', () => {
    expect(resolveAnnotationText(annotation, 'Hello, world! Hello, world!', 2).state).toBe('needs-attention');
  });
  it('keeps a deleted selection unresolved', () => {
    expect(resolveAnnotationText(annotation, 'No matching selection', 2).state).toBe('needs-attention');
  });
  it('reattaches changed text only between unique context in the same section', () => {
    const markdown: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'markdown', start: 12, end: 17, headingPath: ['Greeting'] } } };
    expect(resolveAnnotationText(markdown, '# Greeting\nHello, everyone!', 2)).toMatchObject({ state: 'ready', annotation: { content: { exact: 'everyone' } } });
    expect(resolveAnnotationText(markdown, '# Other\nHello, everyone!', 2).state).toBe('needs-attention');
    expect(resolveAnnotationText(annotation, 'Hello, everyone!', 2).state).toBe('needs-attention');
  });
  it('moves a sheet range while verifying its headers', () => {
    const cells: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'cells', sheet: 'Sheet1', range: 'A2:A2' } }, content: { ...annotation.content, exact: '| Name |\n| --- |\n| Alice |', source: 'converted' } };
    expect(resolveAnnotationText(cells, 'Name\nBob\nAlice', 2)).toMatchObject({ state: 'ready', annotation: { target: { locator: { range: 'A3:A3' } } } });
    expect(resolveAnnotationText(cells, 'Title\nBob\nAlice', 2).state).toBe('needs-attention');
  });
  it('finds moved HTML and rejects a replaced positional element', () => {
    const html: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'element', css: 'button', visibleText: 'Start', box: { x: 0, y: 0, w: 1, h: 1 } } }, content: { ...annotation.content, exact: '<button>Start</button>', before: '', after: '', source: 'rendered' } };
    expect(resolveAnnotationText(html, '<section><button>Start</button></section>', 2)).toMatchObject({ state: 'ready', annotation: { target: { locator: { css: 'body:nth-of-type(1) > section:nth-of-type(1) > button:nth-of-type(1)' } } } });
    expect(resolveAnnotationText(html, '<button>Delete</button>', 2).state).toBe('needs-attention');
    expect(resolveAnnotationText(html, '<button>Start</button><button>Start</button>', 2).state).toBe('needs-attention');
  });
  it('uses a stable HTML ID and both neighboring elements for changed content', () => {
    const html: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'element', css: '#start', visibleText: 'Start', box: { x: 0, y: 0, w: 1, h: 1 } } }, content: { ...annotation.content, exact: '<button id="start">Start</button>', before: 'Before', after: 'After', source: 'rendered' } };
    expect(resolveAnnotationText(html, '<p>Before</p><button id="start">Begin</button><p>After</p>', 2)).toMatchObject({ state: 'ready', annotation: { content: { exact: '<button id="start">Begin</button>' } } });
    expect(resolveAnnotationText(html, '<p>Other</p><button id="start">Begin</button><p>After</p>', 2).state).toBe('needs-attention');
  });
  it('does not reuse image coordinates when image bytes change', async () => {
    const region: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'region', x: 0, y: 0, w: 1, h: 1 } } };
    const readResource = async () => ({ currentVersion: 2 });
    expect((await resolveAnnotation(region, { readResource, readResourceVersion: async (_id, version) => new Blob([String(version)]) }, new AbortController().signal)).state).toBe('needs-attention');
    expect(await resolveAnnotation(region, { readResource, readResourceVersion: async () => new Blob(['same image']) }, new AbortController().signal)).toMatchObject({ state: 'ready', annotation: { target: { version: 2 } } });
  });
  it('keeps an inaccessible artifact for retry', async () => {
    const result = await resolveAnnotation(annotation, { readResource: async () => { throw new Error('offline'); }, readResourceVersion: async () => new Blob() }, new AbortController().signal);
    expect(result).toMatchObject({ state: 'needs-attention', reason: 'The artifact could not be checked. Retry when it is available.' });
  });
});

it('requires manual repair when an identical sheet row is inserted at the old coordinates', () => {
  const cells: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'cells', sheet: 'Sheet1', range: 'A2:A2' } }, content: { ...annotation.content, exact: '| Status |\n| --- |\n| Ready |', source: 'converted' } };
  expect(resolveAnnotationText(cells, 'Status\nReady\nReady', 2).state).toBe('needs-attention');
});

it('does not accept identical image bytes if a newer revision arrived while downloading', async () => {
  const region: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'region', x: 0, y: 0, w: 1, h: 1 } } };
  let currentVersion = 2;
  const result = await resolveAnnotation(region, {
    readResource: async () => ({ currentVersion }),
    readResourceVersion: async () => { currentVersion = 3; return new Blob(['same image']); },
  }, new AbortController().signal);
  expect(result.state).toBe('needs-attention');
});

it('bounds element context consistently when reattaching changed stable elements', () => {
  const html: Annotation = { ...annotation, target: { ...annotation.target, locator: { type: 'element', css: '#start', visibleText: 'Start', box: { x: 0, y: 0, w: 1, h: 1 } } }, content: { ...annotation.content, exact: '<button id="start">Start</button>', before: 'B'.repeat(200), after: 'A'.repeat(200), source: 'rendered' } };
  expect(resolveAnnotationText(html, `<p>${'B'.repeat(400)}</p><button id="start">Begin</button><main>${'A'.repeat(400)}<script>privateCode()</script></main>`, 2)).toMatchObject({state:'ready',annotation:{content:{before:'B'.repeat(200),after:'A'.repeat(200)}}});
  const noContext = {...html,target:{...html.target,locator:{type:'element' as const,css:'#start',visibleText:'Begin',box:{x:0,y:0,w:1,h:1}}},content:{...html.content,exact:'<button id="start">Begin</button>'}};
  expect(resolveAnnotationText(noContext, '<script>privateCode()</script><button id="start">Begin</button><style>body{color:red}</style>', 2)).toMatchObject({state:'ready',annotation:{content:{before:'',after:''}}});
});
