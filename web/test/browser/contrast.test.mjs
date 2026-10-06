import assert from 'node:assert/strict';
import test from 'node:test';
import { isEnhancedContrastFailure } from './contrast.mjs';

test('enhanced contrast ignores disabled controls but still reports enabled low-contrast text', () => {
  const lowRatio = { ratio: 1.2, required: 7 };
  const disabledDiffLabel = { ...lowRatio, disabled: true };
  const enabledLowContrastText = { ...lowRatio, disabled: false };
  assert.equal(isEnhancedContrastFailure(disabledDiffLabel), false);
  assert.equal(isEnhancedContrastFailure(enabledLowContrastText), true);
});
