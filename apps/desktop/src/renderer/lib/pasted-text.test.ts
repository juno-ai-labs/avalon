import { describe, expect, it } from 'vitest';
import { detectTextType } from './pasted-text';

describe('detectTextType', () => {
  it.each([
    ['{"region": "EU", "revenue": [12, 14]}', 'application/json', 'json'],
    ['<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>', 'text/html', 'html'],
    ['<div class="card">\n  <p>Hi</p>\n</div>', 'text/html', 'html'],
    ['<?xml version="1.0"?>\n<feed><entry/></feed>', 'application/xml', 'xml'],
    ['<feed>\n  <entry id="1"/>\n</feed>', 'application/xml', 'xml'],
    ['# Launch plan\n\nShip it.', 'text/markdown', 'md'],
    ['- first item\n- see [the doc](https://example.com)', 'text/markdown', 'md'],
    ['| a | b |\n| --- | --- |\n| 1 | 2 |', 'text/markdown', 'md'],
    ['name\tcount\nEU\t12\nUS\t14', 'text/tab-separated-values', 'tsv'],
    ['name,count\nEU,12\nUS,14', 'text/csv', 'csv'],
    ['Dear team,\nThe launch moves to Tuesday, as agreed, after the review.\nThanks, Adam', 'text/plain', 'txt'],
    ['name,count\nEU,12', 'text/plain', 'txt'],
    ['{ not json', 'text/plain', 'txt'],
    ['- one list is not enough on its own', 'text/plain', 'txt'],
  ])('reads %j as %s', (text, mimeType, extension) => {
    expect(detectTextType(text)).toEqual({ mimeType, extension });
  });
});
