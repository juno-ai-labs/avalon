import { expect, it } from 'vitest';
import { preparedRequests } from './prepared-requests';

const canvas = { canvasId: 'c1' };
const artifact = { canvasId: 'c1', resourceId: 'r1' };
const setup = () => {
  const sent: string[] = [];
  const requests = preparedRequests<typeof canvas, typeof artifact>((command) => { sent.push(command.requestId); });
  return { sent, requests };
};

it('holds an open while Home reloads and sends it once Home can answer', async () => {
  const { sent, requests } = setup();
  requests.setAvailable('u1:w1');
  requests.reload();
  const opening = requests.open('a', 'u1', 'w1', canvas);
  expect(sent).toEqual([]);
  requests.setAvailable(null);
  expect(sent).toEqual([]);
  requests.setAvailable('u1:w1');
  expect(sent).toEqual(['a']);
  requests.reply('a', artifact, 'u1:w1');
  await expect(opening).resolves.toEqual(artifact);
});

it('re-sends an open the reloaded page never answered', async () => {
  const { sent, requests } = setup();
  requests.setAvailable('u1:w1');
  const opening = requests.open('a', 'u1', 'w1', canvas);
  expect(sent).toEqual(['a']);
  requests.reload();
  requests.setAvailable('u1:w1');
  expect(sent).toEqual(['a', 'a']);
  requests.reply('a', artifact, 'u1:w1');
  requests.reply('a', artifact, 'u1:w1');
  await expect(opening).resolves.toEqual(artifact);
});

it('does not send an open to Home serving another organization', async () => {
  const { sent, requests } = setup();
  requests.setAvailable('u1:w2');
  const opening = requests.open('a', 'u1', 'w1', canvas);
  expect(sent).toEqual([]);
  requests.cancel();
  await expect(opening).resolves.toBeNull();
});

it('fails a reply that arrives after the account changed', async () => {
  const { requests } = setup();
  requests.setAvailable('u1:w1');
  const opening = requests.open('a', 'u1', 'w1', canvas);
  requests.reply('a', artifact, 'u2:w1');
  await expect(opening).resolves.toBeNull();
});
