export function isEnhancedContrastFailure({ ratio, required, disabled = false }) {
  return !disabled && ratio < required;
}
