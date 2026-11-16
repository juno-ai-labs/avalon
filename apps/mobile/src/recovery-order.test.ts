import { expect, it } from 'vitest';
import { recoveryOrder } from './recovery-order';

const setup = () => {
  const turns: (() => void)[] = [];
  const order = recoveryOrder((run) => { turns.push(run); });
  const ran: string[] = [];
  const nextTurn = () => { for (const run of turns.splice(0)) run(); };
  return { order, ran, nextTurn };
};

it('reloads a hidden renderer only after the visible one has presented', () => {
  const { order, ran, nextTurn } = setup();
  order.recovering('artifact');
  order.defer('home', () => ran.push('home'));
  nextTurn();
  expect(ran).toEqual([]);
  order.settled('artifact');
  nextTurn();
  expect(ran).toEqual(['home']);
});

it('lets a visible renderer reported after a hidden one in the same pass go first', () => {
  const { order, ran, nextTurn } = setup();
  order.defer('home', () => ran.push('home'));
  order.recovering('artifact');
  nextTurn();
  expect(ran).toEqual([]);
});

it('reloads a hidden renderer with no visible recovery on the next turn', () => {
  const { order, ran, nextTurn } = setup();
  order.defer('home', () => ran.push('home'));
  expect(ran).toEqual([]);
  nextTurn();
  expect(ran).toEqual(['home']);
});

it('reloads a waiting renderer at once when it is shown or needed, and only once', () => {
  const { order, ran, nextTurn } = setup();
  order.recovering('artifact');
  order.defer('home', () => ran.push('home'));
  order.wake('home');
  expect(ran).toEqual(['home']);
  order.settled('artifact');
  nextTurn();
  expect(ran).toEqual(['home']);
});

it('releases the queue when the visible renderer goes away without presenting', () => {
  const { order, ran, nextTurn } = setup();
  order.recovering('artifact');
  order.defer('home', () => ran.push('home'));
  order.forget('artifact');
  nextTurn();
  expect(ran).toEqual(['home']);
});
