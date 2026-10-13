const MONEY_SCALE = 100;

function toMinorUnits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Number.NaN;
  return Math.round((number + Number.EPSILON) * MONEY_SCALE);
}

function fromMinorUnits(value) {
  return value / MONEY_SCALE;
}

function normalizeMoney(value) {
  const minorUnits = toMinorUnits(value);
  return Number.isFinite(minorUnits) ? fromMinorUnits(minorUnits) : value;
}

module.exports = { toMinorUnits, fromMinorUnits, normalizeMoney };
