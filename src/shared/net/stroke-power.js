/**
 * The original cue-power curve, shared so the browser and the authoritative
 * simulation convert between a 0..1 power value and a launch speed identically.
 * speed(p) = (0.5 + 11p) * (3.2 + 6p) = 66p^2 + 38.2p + 1.6
 */
export default function strokePowerModule(module) {
  const MIN_SPEED = 1.6;
  const LINEAR = 38.2;
  const QUADRATIC = 66;
  const MAX_SPEED = QUADRATIC + LINEAR + MIN_SPEED;

  function speedFromPower(power) {
    const p = clampPower(power);
    return (0.5 + 11 * p) * (3.2 + 6 * p);
  }

  function powerFromSpeed(speed) {
    if (!Number.isFinite(speed)) {
      return 0;
    }
    const discriminant = LINEAR * LINEAR + 4 * QUADRATIC * (speed - MIN_SPEED);
    if (discriminant <= 0) {
      return 0;
    }
    const power = (-LINEAR + Math.sqrt(discriminant)) / (2 * QUADRATIC);
    return clampPower(power);
  }

  function clampPower(power) {
    if (!Number.isFinite(power)) {
      return 0;
    }
    return Math.min(1, Math.max(0, power));
  }

  const api = { MIN_SPEED, MAX_SPEED, speedFromPower, powerFromSpeed, clampPower };
  if (module) {
    module.exports = api;
  }
  return api;
}
