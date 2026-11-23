// Turns a value like "5" into the number 5. Returns null if it isn't a valid id.
function toId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = toId;