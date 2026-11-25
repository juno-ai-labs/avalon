import { expect, it } from 'vitest';
import { FIRST_STEP, nextStep, stepItems } from './rolling-step';

it('rolls through every item and back to the first', () => {
  const second = nextStep(FIRST_STEP, 3);
  const third = nextStep(second, 3);
  expect([second, third, nextStep(third, 3)]).toEqual([{ index: 1, previous: 0 }, { index: 2, previous: 1 }, { index: 0, previous: 2 }]);
});

it('reads a step from Drive’s three marks within Gmail’s two', () => {
  expect(stepItems(['Gmail', 'Calendar'], { index: 2, previous: 1 })).toEqual({ shown: 'Gmail', before: 'Calendar' });
  expect(stepItems(['Gmail', 'Calendar'], { index: 0, previous: 2 })).toEqual({ shown: 'Gmail', before: 'Gmail' });
  expect(stepItems(['Gmail', 'Calendar'], FIRST_STEP)).toEqual({ shown: 'Gmail', before: null });
});
